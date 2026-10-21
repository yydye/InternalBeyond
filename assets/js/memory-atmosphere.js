/* ============================================================================
   Memory Atmosphere · 记忆氛围层
   ----------------------------------------------------------------------------
   ROLE ................ PRESENTATION_LAYER_ONLY（纯展示，零数据写入）
   MOUNT ............... 由 assets/js/memory-sky.js 在运行时注入（与
                        memory-world.js 同一套接缝）；样式由本模块自己挂
                        <link id="ib-mem-atmos-style">，不触碰 InternalBeyond.html。
   DATA ................ 只读 DOM：.mem-card / .empty-state / pinned 计数；
                        NEVER 调用 db / memory API，NEVER 写 memory。
   PERF ................ 背景星雾一次性烘焙成 canvas（之后只有 CSS transform）；
                        花瓣按 30fps 上限绘制、DPR 与像素面积双封顶；页面不在
                        前台、document.hidden、reduced-motion 或关闭时停 rAF 并
                        冻结 CSS 动画；不使用定时器驱动视觉。
   THEME ............... 全部颜色从 core.css 语义 token 解析（浅色 Internal /
                        暗色 Infernal），主题切换时重烘焙枝 / 星雾 / 花瓣精灵。
   API ................. window.IB.memoryAtmosphere（由 NS.expose 暴露）。
   ============================================================================ */
(function (NS) {
  'use strict';

  var VERSION = 'memory-atmosphere-1.1.0';
  var CSS_HREF = 'assets/css/memory-atmosphere.css';
  var CSS_ID = 'ib-mem-atmos-style';
  var STORE_KEY = 'ib.memory.atmosphere';
  var BACK_ID = 'ib-mem-atmos-back';
  var FRONT_ID = 'ib-mem-atmos-front';

  var PETAL_BASE = 12;
  var PETAL_CAP = 22;
  var PETAL_QUIET = 6;
  var PETAL_DPR_CAP = 1.75;
  var BACK_DPR_CAP = 1.5;
  var PIXEL_CAP = 2400000;      /* 单张 canvas 的像素面积上限（约 2.4M） */
  var TARGET_FPS = 30;
  var FRAME_MS = 1000 / TARGET_FPS;
  var MOTE_COUNT = 10;
  var RESONANCE_MS = 1600;
  var RESONANCE_THROTTLE = 500;
  var COUNT_DEBOUNCE = 400;

  var WHITE = { r: 246, g: 250, b: 255, a: 1 };

  var state = {
    mounted: false,
    mountMs: 0,
    enabled: true,
    pageActive: false,
    paused: true,
    reduced: false,
    baked: false,
    dark: false,
    dpr: 1,
    w: 0,
    h: 0,
    petals: 0,
    target: PETAL_BASE,
    motes: 0,
    frames: 0,
    fps: 0,
    lastPaint: 0,
    cardCount: 0,
    pinned: 0,
    quiet: true,
    countReady: false,
    toggles: 0,
    lastError: null,
    lastResonance: 0,
    resonanceTimer: 0
  };

  var dom = {};
  var probe = null;
  var page = null;
  var list = null;
  var palette = null;
  var reduceQuery = null;

  var raf = 0;
  var petalCtx = null;
  var petalSprites = [];
  var goldSprites = [];
  var petals = [];
  var resizeTimer = 0;
  var countTimer = 0;
  var themePending = false;
  var themeRaf = 0;

  /* --------------------------------------------------------------- helpers */

  function now() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function nowMark() { return now(); }

  function isDarkTheme() {
    return !!(document.body && document.body.classList.contains('theme-infernal'));
  }

  function parseColor(value) {
    var m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/i.exec(String(value || ''));
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  }

  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) {
      var s = /^#?([0-9a-f]{3})$/i.exec(String(hex || '').trim());
      if (!s) return null;
      var v = s[1];
      return { r: parseInt(v[0] + v[0], 16), g: parseInt(v[1] + v[1], 16), b: parseInt(v[2] + v[2], 16), a: 1 };
    }
    var h = m[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }

  function parseAnyColor(value) {
    return parseColor(value) || hexToRgb(value);
  }

  function mix(a, b, t) {
    return {
      r: a.r + (b.r - a.r) * t,
      g: a.g + (b.g - a.g) * t,
      b: a.b + (b.b - a.b) * t,
      a: (a.a === undefined ? 1 : a.a) + ((b.a === undefined ? 1 : b.a) - (a.a === undefined ? 1 : a.a)) * t
    };
  }

  function rgbStr(c) {
    return 'rgb(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ')';
  }

  function rgbaStr(c, alpha) {
    var a = alpha === undefined ? (c.a === undefined ? 1 : c.a) : alpha;
    a = clamp(a, 0, 1);
    return 'rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ',' + (Math.round(a * 1000) / 1000) + ')';
  }

  function seeded(seed) {
    var s = seed >>> 0;
    return function () {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function fmt(n) { return Math.round(n * 10) / 10; }

  function navWidth() {
    try {
      var target = document.body || document.documentElement;
      var v = getComputedStyle(target).getPropertyValue('--ib-navigation-width');
      var n = parseFloat(v);
      return isFinite(n) ? n : 260;
    } catch (e) {
      return 260;
    }
  }

  /* ------------------------------------------------------------- 调色板 */
  /* canvas / SVG 需要具体颜色。让浏览器解析语义 token（var() 与 color-mix()
     都会落到 computed style 上），因此本模块与 CSS 都不出现原生色值。 */

  function cssVar(name) {
    if (!probe) return '';
    try { return String(getComputedStyle(probe).getPropertyValue(name) || '').trim(); } catch (e) { return ''; }
  }

  function colorFromVar(name) {
    if (!probe || !cssVar(name)) return null;
    try {
      probe.style.setProperty('color', 'var(' + name + ')');
      var c = parseColor(getComputedStyle(probe).color);
      probe.style.removeProperty('color');
      return c;
    } catch (e) {
      try { probe.style.removeProperty('color'); } catch (e2) { /* noop */ }
      return null;
    }
  }

  /* 语义角色优先；该角色缺席时退回既有原语（与 memory-world 相同的 alias-first）。 */
  function roleColor(role, legacyLight, legacyDark, fallback) {
    var dark = isDarkTheme();
    var value = colorFromVar(role);
    if (value) return value;
    var legacy = dark ? (legacyDark || legacyLight) : legacyLight;
    var fromLegacy = legacy ? colorFromVar(legacy) : null;
    return fromLegacy || fallback;
  }

  /* --mem-gold 只声明在 #page-memory 上，不属于 :root —— 从页面元素上读。 */
  function goldColor() {
    try {
      if (!page) return null;
      return parseAnyColor(String(getComputedStyle(page).getPropertyValue('--mem-gold') || '').trim());
    } catch (e) {
      return null;
    }
  }

  function buildPalette() {
    var dark = isDarkTheme();
    var canvas = roleColor('--ib-token-canvas', '--pale', '--bg-deep',
      dark ? { r: 24, g: 30, b: 50, a: 1 } : { r: 226, g: 233, b: 245, a: 1 });
    var ink = roleColor('--ib-token-content-primary', '--content-primary', '--content-primary',
      dark ? { r: 224, g: 230, b: 242, a: 1 } : { r: 26, g: 50, b: 98, a: 1 });
    var muted = roleColor('--ib-token-content-muted', '--content-muted', '--content-muted',
      dark ? { r: 126, g: 144, b: 178, a: 1 } : { r: 82, g: 111, b: 150, a: 1 });
    var accent = roleColor('--ib-token-accent-brand', '--accent', '--accent',
      dark ? { r: 114, g: 168, b: 216, a: 1 } : { r: 80, g: 128, b: 176, a: 1 });
    var accentLight = roleColor('--ib-token-accent-hover', '--accent-light', '--accent-light',
      dark ? { r: 114, g: 168, b: 216, a: 1 } : { r: 114, g: 168, b: 216, a: 1 });
    var warm = roleColor('--ib-token-status-warning', '--status-warning', '--status-warning',
      { r: 181, g: 138, b: 85, a: 1 });
    var ice = { r: 236, g: 246, b: 255, a: 1 };
    var gold = goldColor() || warm;

    return {
      dark: dark,
      canvas: canvas,
      ink: ink,
      muted: muted,
      accent: accent,
      accentLight: accentLight,
      warm: warm,
      gold: gold,
      deep: mix(canvas, { r: 3, g: 6, b: 14, a: 1 }, dark ? 0.62 : 0.10),
      /* 深色 = 近剪影的夜枝 + 一线冷光；浅色 = 雾蓝灰枝条，靠 alpha 保持低对比。 */
      bough: dark ? mix(canvas, { r: 4, g: 8, b: 18, a: 1 }, 0.52) : mix(canvas, ink, 0.50),
      rim: dark ? mix(accentLight, ice, 0.36) : mix(ice, accent, 0.30),
      blossom: dark ? mix(ice, accentLight, 0.18) : mix(WHITE, accent, 0.30),
      blossomInner: dark ? mix(ice, WHITE, 0.55) : mix(WHITE, accent, 0.12),
      motes: mix(ice, accentLight, dark ? 0.30 : 0.18),
      dust: dark ? mix(accentLight, ice, 0.45) : mix(accent, ink, 0.22),
      mist: mix(WHITE, accent, 0.10),
      /* 暗色花瓣 = 淡冰象牙白；浅色花瓣 = 柔和的蓝灰，避免在雾白里消失。 */
      petals: dark
        ? [mix(ice, WHITE, 0.35), mix(WHITE, warm, 0.07), mix(ice, accentLight, 0.22)]
        : [mix(accent, ink, 0.30), mix(accentLight, ink, 0.42), mix(accent, ink, 0.16)],
      petalGold: mix(WHITE, gold, 0.30)
    };
  }

  /* --------------------------------------------------------- 枝 / 花 SVG */

  function cubic(p0, c0, c1, p1, n, out) {
    var i, t, mt, a, b, c, d;
    for (i = 1; i <= n; i++) {
      t = i / n; mt = 1 - t;
      a = mt * mt * mt; b = 3 * mt * mt * t; c = 3 * mt * t * t; d = t * t * t;
      out.push([
        a * p0[0] + b * c0[0] + c * c1[0] + d * p1[0],
        a * p0[1] + b * c0[1] + c * c1[1] + d * p1[1]
      ]);
    }
    return out;
  }

  function chain(segs, per) {
    var pts = [segs[0][0]];
    for (var i = 0; i < segs.length; i++) cubic(segs[i][0], segs[i][1], segs[i][2], segs[i][3], per, pts);
    return pts;
  }

  /* 中心线 → 由粗到细的填充枝条多边形（无需 SVG 描边宽度动画）。 */
  function taperPath(pts, w0, w1) {
    var n = pts.length - 1, left = [], right = [], i, p, a, b, dx, dy, len, nx, ny, w, t;
    for (i = 0; i <= n; i++) {
      p = pts[i]; a = pts[i ? i - 1 : 0]; b = pts[i < n ? i + 1 : n];
      dx = b[0] - a[0]; dy = b[1] - a[1]; len = Math.sqrt(dx * dx + dy * dy) || 1;
      nx = -dy / len; ny = dx / len; t = i / n; w = (w0 + (w1 - w0) * t) * 0.5;
      left.push([p[0] + nx * w, p[1] + ny * w]);
      right.push([p[0] - nx * w, p[1] - ny * w]);
    }
    var d = 'M' + fmt(left[0][0]) + ' ' + fmt(left[0][1]);
    for (i = 1; i <= n; i++) d += 'L' + fmt(left[i][0]) + ' ' + fmt(left[i][1]);
    for (i = n; i >= 0; i--) d += 'L' + fmt(right[i][0]) + ' ' + fmt(right[i][1]);
    return d + 'Z';
  }

  /* 枝条受光侧的一线冷光（不是外发光，只是边缘亮线）。 */
  function rimPath(pts, w0, w1) {
    var n = pts.length - 1, out = '', i, p, a, b, dx, dy, len, nx, ny, w, t, qx, qy;
    for (i = 0; i <= n; i++) {
      p = pts[i]; a = pts[i ? i - 1 : 0]; b = pts[i < n ? i + 1 : n];
      dx = b[0] - a[0]; dy = b[1] - a[1]; len = Math.sqrt(dx * dx + dy * dy) || 1;
      nx = dy / len; ny = -dx / len; t = i / n; w = (w0 + (w1 - w0) * t) * 0.5;
      qx = p[0] + nx * (w - 1.1); qy = p[1] + ny * (w - 1.1);
      out += (i ? 'L' : 'M') + fmt(qx) + ' ' + fmt(qy);
    }
    return out;
  }

  /* 花簇：5 瓣 + 内层小瓣 + 极少量暖金花心。桌面 1:1 时屏幕直径约 18-22px，
     在 100% 缩放下能读出是一朵花，而不是一颗光点。 */
  function blossomCluster(x, y, scale, pal) {
    var petalFill = rgbaStr(pal.blossom, pal.dark ? 0.82 : 0.86);
    var innerFill = rgbaStr(mix(pal.blossom, pal.blossomInner, 0.55), pal.dark ? 0.55 : 0.6);
    var coreFill = rgbaStr(pal.gold, pal.dark ? 0.62 : 0.5);
    var out = '<g transform="translate(' + fmt(x) + ' ' + fmt(y) + ') scale(' + scale + ')">';
    var i, deg, rad, px, py;
    for (i = 0; i < 5; i++) {
      deg = -90 + i * 72; rad = deg * Math.PI / 180;
      px = Math.cos(rad) * 5.6; py = Math.sin(rad) * 5.6;
      out += '<ellipse cx="' + fmt(px) + '" cy="' + fmt(py) + '" rx="6.6" ry="3.9" fill="' + petalFill +
        '" transform="rotate(' + deg + ' ' + fmt(px) + ' ' + fmt(py) + ')"/>';
    }
    for (i = 0; i < 5; i++) {
      deg = -54 + i * 72; rad = deg * Math.PI / 180;
      px = Math.cos(rad) * 2.9; py = Math.sin(rad) * 2.9;
      out += '<ellipse cx="' + fmt(px) + '" cy="' + fmt(py) + '" rx="4.1" ry="2.4" fill="' + innerFill +
        '" transform="rotate(' + deg + ' ' + fmt(px) + ' ' + fmt(py) + ')"/>';
    }
    out += '<circle r="2" fill="' + coreFill + '"/>';
    return out + '</g>';
  }

  function bud(x, y, pal) {
    return '<circle cx="' + fmt(x) + '" cy="' + fmt(y) + '" r="2.1" fill="' +
      rgbaStr(pal.blossom, pal.dark ? 0.6 : 0.66) + '"/>';
  }

  function twigSvg(tw, pal, fill, rim) {
    var pts = chain([[tw.p0, tw.c0, tw.c1, tw.p1]], 14);
    return '<path d="' + taperPath(pts, tw.w0, tw.w1) + '" fill="' + fill + '"/>' +
      '<path d="' + rimPath(pts, tw.w0, tw.w1) + '" fill="none" stroke="' + rim +
      '" stroke-width="1" stroke-linecap="round" opacity=".8"/>';
  }

  /* 可见切片按「视口左缘约 150px 宽、约 420px 高」来构图（桌面 1:1）：
     主干从画面左下（多数在视口外）以连续 S 形伸向右上，3-4 条次级枝自然分叉，
     花簇落在枝梢；右缘用 SVG mask 渐隐，枝条不会在文字列前硬切。
     窄视口交给 CSS 缩放/隐藏，并依赖同一层渐隐兜底。 */
  var BOUGH_VB_W = 220;
  var BOUGH_VB_H = 640;

  function boughSvg(pal, far) {
    var fill = rgbaStr(pal.bough, pal.dark ? (far ? 0.40 : 0.94) : (far ? 0.38 : 0.62));
    var rim = rgbaStr(pal.rim, pal.dark ? (far ? 0.16 : 0.34) : (far ? 0.22 : 0.46));
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 640" preserveAspectRatio="xMinYMin meet">';
    svg += '<defs>' +
      '<linearGradient id="ibm-fade" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="220" y2="0">' +
      '<stop offset="0.78" stop-color="rgb(255,255,255)"/>' +
      '<stop offset="1" stop-color="rgb(0,0,0)"/>' +
      '</linearGradient>' +
      '<mask id="ibm-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="220" height="640">' +
      '<rect x="0" y="0" width="220" height="640" fill="url(#ibm-fade)"/>' +
      '</mask>' +
      '</defs><g mask="url(#ibm-mask)">';

    if (far) {
      /* 远枝：更细、更淡、无花簇，只作为纵深暗示。 */
      var farTrunk = chain([
        [[-20, 420], [22, 402], [46, 386], [66, 370]],
        [[66, 370], [92, 350], [114, 328], [134, 300]],
        [[134, 300], [150, 276], [164, 250], [174, 222]]
      ], 16);
      svg += '<path d="' + taperPath(farTrunk, 9, 1.2) + '" fill="' + fill + '"/>';
      svg += '<path d="' + rimPath(farTrunk, 9, 1.2) + '" fill="none" stroke="' + rim +
        '" stroke-width="0.9" stroke-linecap="round"/>';
      svg += twigSvg({ p0: [114, 328], c0: [126, 308], c1: [134, 290], p1: [138, 268], w0: 3.2, w1: 0.7 }, pal, fill, rim);
      svg += twigSvg({ p0: [134, 300], c0: [148, 296], c1: [158, 290], p1: [166, 282], w0: 2.6, w1: 0.7 }, pal, fill, rim);
      svg += bud(174, 222, pal) + bud(138, 268, pal) + bud(166, 282, pal);
    } else {
      var trunk = chain([
        [[-30, 700], [10, 640], [32, 590], [58, 540]],
        [[58, 540], [86, 492], [106, 448], [120, 404]],
        [[120, 404], [136, 354], [150, 306], [160, 258]],
        [[160, 258], [170, 204], [180, 152], [188, 96]],
        [[188, 96], [191, 78], [194, 64], [196, 52]]
      ], 18);
      svg += '<path d="' + taperPath(trunk, 20, 2) + '" fill="' + fill + '"/>';
      svg += '<path d="' + rimPath(trunk, 20, 2) + '" fill="none" stroke="' + rim +
        '" stroke-width="1.3" stroke-linecap="round"/>';
      var twigs = [
        { p0: [120, 404], c0: [148, 392], c1: [174, 374], p1: [200, 354], w0: 6.5, w1: 1.1 },
        { p0: [160, 258], c0: [184, 250], c1: [200, 240], p1: [214, 226], w0: 5.5, w1: 1 },
        { p0: [150, 306], c0: [134, 282], c1: [128, 258], p1: [128, 232], w0: 5, w1: 1 },
        { p0: [188, 96], c0: [198, 86], c1: [206, 78], p1: [212, 66], w0: 3.8, w1: 0.9 },
        { p0: [200, 354], c0: [208, 344], c1: [212, 334], p1: [214, 324], w0: 3, w1: 0.8 },
        { p0: [128, 232], c0: [122, 216], c1: [118, 202], p1: [120, 188], w0: 2.8, w1: 0.8 },
        { p0: [86, 492], c0: [98, 468], c1: [104, 450], p1: [106, 432], w0: 4, w1: 0.9 },
        { p0: [170, 204], c0: [158, 186], c1: [150, 172], p1: [146, 158], w0: 3.2, w1: 0.8 },
        { p0: [106, 432], c0: [112, 420], c1: [116, 410], p1: [118, 400], w0: 2.2, w1: 0.7 }
      ];
      for (var t = 0; t < twigs.length; t++) svg += twigSvg(twigs[t], pal, fill, rim);
      svg += blossomCluster(180, 366, 1.05, pal);
      svg += blossomCluster(128, 232, 0.95, pal);
      svg += blossomCluster(174, 120, 0.9, pal);
      svg += blossomCluster(160, 258, 0.6, pal);
      svg += blossomCluster(146, 158, 0.62, pal);
      svg += blossomCluster(106, 432, 0.55, pal);
      svg += blossomCluster(150, 306, 0.5, pal);
      svg += blossomCluster(150, 440, 0.55, pal);
      svg += blossomCluster(120, 188, 0.5, pal);
      svg += bud(214, 324, pal) + bud(214, 226, pal) + bud(206, 86, pal) + bud(118, 400, pal);
    }
    return svg + '</g></svg>';
  }

  function svgDataUri(svg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /* --------------------------------------------------- canvas 尺寸与烘焙 */

  function sizeCanvas(canvas, maxDpr) {
    var w = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    var h = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    var dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    if (w * h * dpr * dpr > PIXEL_CAP) dpr = Math.sqrt(PIXEL_CAP / (w * h));
    dpr = clamp(dpr, 0.5, Math.min(maxDpr, 1.6));
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    var ctx = canvas.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h, dpr: dpr };
  }

  function softBlob(ctx, x, y, r, color, alpha) {
    var g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgbaStr(color, alpha));
    g.addColorStop(0.55, rgbaStr(color, alpha * 0.42));
    g.addColorStop(1, rgbaStr(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 6.2831853);
    ctx.fill();
  }

  function drawNebula(ctx, w, h, pal) {
    var max = Math.max(w, h);
    ctx.clearRect(0, 0, w, h);
    softBlob(ctx, w * 0.16, h * 0.20, max * 0.86, pal.accent, pal.dark ? 0.16 : 0.085);
    softBlob(ctx, w * 0.56, h * 0.10, max * 0.60, pal.accentLight, pal.dark ? 0.08 : 0.05);
    softBlob(ctx, w * 0.24, h * 0.78, max * 0.54, pal.warm, pal.dark ? 0.05 : 0.032);
    var g;
    if (pal.dark) {
      g = ctx.createLinearGradient(0, h * 0.42, 0, h);
      g.addColorStop(0, rgbaStr(pal.deep, 0));
      g.addColorStop(1, rgbaStr(pal.deep, 0.22));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    } else {
      g = ctx.createLinearGradient(0, 0, 0, h * 0.58);
      g.addColorStop(0, rgbaStr(pal.mist, 0.16));
      g.addColorStop(1, rgbaStr(pal.mist, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    /* 极淡尘点：只落在左上象限，与枝同侧，密度很低。 */
    var s = seeded(0x5eed1);
    var dots = Math.round(Math.min(240, (w * h) / 11000));
    for (var i = 0; i < dots; i++) {
      var x = s() * w * 0.72;
      var y = s() * h * 0.66;
      ctx.fillStyle = rgbaStr(pal.dust, 0.02 + s() * 0.045);
      ctx.beginPath();
      ctx.arc(x, y, 0.6 + s() * 0.7, 0, 6.2831853);
      ctx.fill();
    }
  }

  function drawMotes(ctx, w, h, pal) {
    ctx.clearRect(0, 0, w, h);
    var s = seeded(0x9e3779b1);
    for (var i = 0; i < MOTE_COUNT; i++) {
      var x = w * (0.05 + s() * 0.62);
      var y = h * (0.06 + s() * 0.72);
      var r = 1.4 + s() * 2.6;
      var a = (pal.dark ? 0.15 : 0.09) + s() * 0.11;
      var g = ctx.createRadialGradient(x, y, 0, x, y, r * 3.4);
      g.addColorStop(0, rgbaStr(pal.motes, a));
      g.addColorStop(1, rgbaStr(pal.motes, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r * 3.4, 0, 6.2831853);
      ctx.fill();
      ctx.fillStyle = rgbaStr(pal.motes, Math.min(1, a * 1.15));
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, r * 0.32), 0, 6.2831853);
      ctx.fill();
    }
  }

  /* 花瓣精灵（两族）：(a) 单片修长花瓣，轮廓明确、只有极窄的边缘柔化；
     (b) 5 瓣小花剪影，瓣缘可辨、花心略深。精灵按 48px 预渲染，
     运行时缩放到 9-18px，因此在 100% 缩放下仍能读出形状，而不是一团光斑。 */
  function petalSprite(color, blossomFamily, centerColor) {
    var S = 48;
    var c = document.createElement('canvas');
    c.width = S; c.height = S;
    var g = c.getContext('2d');
    if (!g) return null;
    g.translate(S / 2, S / 2);
    if (blossomFamily) {
      var i, deg, rad, px, py, petal;
      for (i = 0; i < 5; i++) {
        deg = -90 + i * 72; rad = deg * Math.PI / 180;
        px = Math.cos(rad) * 8.5; py = Math.sin(rad) * 8.5;
        petal = g.createRadialGradient(0, 0, 0.5, 0, 0, 10.5);
        petal.addColorStop(0, rgbaStr(color, 0.88));
        petal.addColorStop(0.62, rgbaStr(color, 0.8));
        petal.addColorStop(0.9, rgbaStr(color, 0.5));
        petal.addColorStop(1, rgbaStr(color, 0));
        g.save();
        g.translate(px, py);
        g.rotate(rad);
        g.fillStyle = petal;
        g.beginPath();
        g.ellipse(0, 0, 9.6, 5.7, 0, 0, 6.2831853);
        g.fill();
        g.restore();
      }
      g.fillStyle = rgbaStr(centerColor || color, 0.6);
      g.beginPath();
      g.arc(0, 0, 2.9, 0, 6.2831853);
      g.fill();
    } else {
      var grad = g.createRadialGradient(0, -1, 1, 0, 0, 17);
      grad.addColorStop(0, rgbaStr(color, 0.9));
      grad.addColorStop(0.62, rgbaStr(color, 0.82));
      grad.addColorStop(0.88, rgbaStr(color, 0.55));   /* 明确边缘，不做大范围虚化 */
      grad.addColorStop(1, rgbaStr(color, 0));
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(0, -19);
      g.bezierCurveTo(11, -13, 12, 5, 0, 19);
      g.bezierCurveTo(-12, 5, -11, -13, 0, -19);
      g.fill();
      g.strokeStyle = rgbaStr(color, 0.26);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, -15);
      g.lineTo(0, 15);
      g.stroke();
    }
    return c;
  }

  function bakePetalSprites() {
    var pal = palette || buildPalette();
    petalSprites = [];
    goldSprites = [];
    var dark = pal.dark;
    for (var i = 0; i < pal.petals.length; i++) {
      var color = pal.petals[i];
      var center = dark ? mix(color, pal.canvas, 0.5) : mix(color, pal.ink, 0.45);
      var single = petalSprite(color, false, center);
      var blossom = petalSprite(color, true, center);
      if (single) petalSprites.push(single);
      if (blossom) petalSprites.push(blossom);   /* 0-2 单瓣 / 3-5 小花 */
    }
    var goldCenter = dark ? mix(pal.petalGold, pal.canvas, 0.5) : mix(pal.petalGold, pal.ink, 0.4);
    var goldSingle = petalSprite(pal.petalGold, false, goldCenter);
    var goldBlossom = petalSprite(pal.petalGold, true, goldCenter);
    if (goldSingle) goldSprites.push(goldSingle);
    if (goldBlossom) goldSprites.push(goldBlossom);
    if (!petalSprites.length) petalSprites.push(petalSprite(WHITE, false, WHITE));
    if (!goldSprites.length) goldSprites = petalSprites.slice(0, 1);
  }

  function bakeBough() {
    try {
      dom.boughMain.src = svgDataUri(boughSvg(palette, false));
      dom.boughFar.src = svgDataUri(boughSvg(palette, true));
      dom.front.style.setProperty('--ib-mem-warm', rgbaStr(palette.gold, 0.9));
    } catch (e) {
      softFail(e, 'bough');
    }
  }

  function bakeBack() {
    var pal = palette || buildPalette();
    try {
      var n = sizeCanvas(dom.nebula, BACK_DPR_CAP);
      if (n.ctx) drawNebula(n.ctx, n.w, n.h, pal);
    } catch (e) {
      softFail(e, 'nebula');
    }
    try {
      var m = sizeCanvas(dom.motes, BACK_DPR_CAP);
      if (m.ctx) drawMotes(m.ctx, m.w, m.h, pal);
    } catch (e) {
      softFail(e, 'motes');
    }
    state.motes = MOTE_COUNT;
  }

  /* --------------------------------------------------------------- 花瓣 */

  function makePetal() {
    return {
      live: false, gold: false, x: 0, y: 0, vy: 14, amp: 10, freq: 0.3, ph: 0,
      rot: 0, rotV: -0.1, size: 9, alpha: 0.6, sp: 0, drift: 0
    };
  }

  function spawnPetal(p, forceTip) {
    var vw = state.w || window.innerWidth || 1;
    var vh = state.h || window.innerHeight || 1;
    var spawnW = Math.min(vw * 0.22, 320);
    var roll = Math.random();
    if (forceTip || roll < 0.40) {
      /* 由枝梢 / 枝的上方释出 */
      p.x = spawnW * (0.45 + Math.random() * 0.5);
      p.y = vh * 0.03 + Math.random() * vh * 0.16;
    } else if (roll < 0.85) {
      p.x = Math.random() * spawnW;
      p.y = Math.random() * vh * 0.40;
    } else {
      /* 少量从画面顶缘飘入 */
      p.x = Math.random() * vw;
      p.y = -16 - Math.random() * vh * 0.06;
    }
    var colorIdx = petalSprites.length ? (Math.random() * Math.min(3, Math.ceil(petalSprites.length / 2))) | 0 : 0;
    var blossom = Math.random() < 0.34;   /* 约 1/3 是 5 瓣小花 */
    p.sp = blossom ? colorIdx + 3 : colorIdx;
    p.gold = false;
    p.vy = 12 + Math.random() * 14;
    p.amp = 5 + Math.random() * 13;
    p.freq = 0.16 + Math.random() * 0.36;
    p.ph = Math.random() * 6.2831853;
    p.rot = Math.random() * 6.2831853;
    p.rotV = (Math.random() < 0.5 ? -1 : 1) * (0.05 + Math.random() * 0.16);
    p.size = blossom ? 13 + Math.random() * 6 : 9 + Math.random() * 7;
    p.alpha = 0.45 + Math.random() * 0.35;
    p.drift = (Math.random() * 2 - 1) * 3;
    p.live = true;
  }

  function syncPetals() {
    for (var i = 0; i < PETAL_CAP; i++) {
      var p = petals[i];
      if (!p) { p = petals[i] = makePetal(); }
      if (i < state.petals) {
        if (!p.live) spawnPetal(p, false);
      } else if (p.live) {
        p.live = false;
      }
    }
  }

  function layoutPetals() {
    if (!dom.petals) return;
    try {
      var sized = sizeCanvas(dom.petals, PETAL_DPR_CAP);
      petalCtx = sized.ctx;
      state.w = sized.w;
      state.h = sized.h;
      state.dpr = sized.dpr;
      for (var i = 0; i < PETAL_CAP; i++) if (petals[i]) petals[i].live = false;
      syncPetals();
    } catch (e) {
      softFail(e, 'petals-layout');
      petalCtx = null;
    }
  }

  function paintPetals(nowMs, dt) {
    if (!petalCtx) return;
    var w = state.w, h = state.h;
    var t = nowMs / 1000;
    petalCtx.clearRect(0, 0, w, h);
    for (var i = 0; i < state.petals; i++) {
      var p = petals[i];
      if (!p || !p.live) continue;
      p.y += p.vy * dt;
      p.x += Math.sin(t * p.freq + p.ph) * p.amp * dt + p.drift * dt;
      p.rot += p.rotV * dt;
      if (p.y > h + 40 || p.x < -50 || p.x > w + 50 || p.y < -100) { spawnPetal(p, false); continue; }
      var arr = (p.gold && goldSprites.length) ? goldSprites : petalSprites;
      var sprite = arr[p.sp % arr.length] || arr[0];
      if (!sprite) continue;
      var s = p.size;
      var a = p.alpha * (0.66 + 0.34 * clamp(p.y / h, 0, 1));
      petalCtx.save();
      petalCtx.translate(p.x, p.y);
      petalCtx.rotate(p.rot);
      petalCtx.globalAlpha = clamp(a, 0, 1);
      petalCtx.drawImage(sprite, -s * 0.5, -s * 0.5, s, s);
      petalCtx.restore();
    }
  }

  function loopFrame(nowMs) {
    raf = 0;
    if (!state.baked || !state.enabled || state.reduced || !state.pageActive || document.hidden) return;
    var last = state.lastPaint;
    if (last) {
      var dt = nowMs - last;
      if (dt < FRAME_MS - 2) { scheduleFrame(); return; }   /* 30fps 上限 */
      state.lastPaint = nowMs;
      try {
        paintPetals(nowMs, Math.min(dt, 90) / 1000);
      } catch (e) {
        softFail(e, 'petals-paint');
        stopPetals(true);
        return;
      }
      state.frames++;
      var instant = 1000 / Math.max(dt, 1);
      state.fps = state.fps ? state.fps * 0.88 + instant * 0.12 : instant;
    } else {
      state.lastPaint = nowMs;
    }
    scheduleFrame();
  }

  function scheduleFrame() {
    if (raf) return;
    if (!state.baked || !state.enabled || state.reduced || !state.pageActive || document.hidden) return;
    raf = window.requestAnimationFrame ? requestAnimationFrame(loopFrame) : 0;
  }

  function startPetals() {
    if (!state.baked || state.enabled === false || state.reduced) return;
    if (!petalCtx) layoutPetals();
    syncPetals();
    state.lastPaint = 0;
    scheduleFrame();
  }

  function stopPetals(clear) {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    /* 页面切走时保留最后一帧，让 1.8s 淡出里花瓣还在原位；
       关闭 / reduced-motion / 绘制异常时才真正清空。 */
    if (clear && petalCtx && state.w && state.h) {
      try { petalCtx.clearRect(0, 0, state.w, state.h); } catch (e) { /* noop */ }
    }
  }

  function releasePetals(count, gold) {
    if (!state.baked || !state.enabled || state.reduced || state.petals <= 0) return;
    var n = Math.max(1, Math.min(count || 1, 3));
    for (var i = 0; i < n; i++) {
      var p = petals[(Math.random() * state.petals) | 0];
      if (!p) continue;
      spawnPetal(p, true);
      if (gold && goldSprites.length) {
        /* 稀有暖金花瓣只给置顶记忆的共振时刻。 */
        p.gold = true;
        p.sp = (Math.random() * goldSprites.length) | 0;
        p.size = 12 + Math.random() * 5;
        p.alpha = 0.62 + Math.random() * 0.24;
        p.vy = 10 + Math.random() * 8;
      }
    }
    if (!petalCtx) layoutPetals();
    scheduleFrame();
  }

  /* --------------------------------------------------- 弱关联（只读 DOM） */

  function readAssociation() {
    var count = 0, pinned = 0, empty = false;
    try {
      if (!list) list = document.getElementById('mem-list');
      if (!page) page = document.getElementById('page-memory');
      if (list) {
        count = list.querySelectorAll('.mem-card').length;
        pinned = list.querySelectorAll('.mem-card.mem-pinned').length;
      }
      empty = !!(list && list.querySelector('.empty-state')) ||
        !!(page && page.querySelector('.empty-state'));
    } catch (e) {
      /* 只读观测失败不构成页面错误：保持上一次计数。 */
    }
    return { count: count, pinned: pinned, quiet: count === 0 || empty };
  }

  function updatePetalTarget() {
    var target;
    if (state.quiet) {
      target = PETAL_QUIET;
    } else {
      target = Math.min(PETAL_CAP, PETAL_BASE + Math.round(state.cardCount * 0.8) + (state.pinned > 0 ? 1 : 0));
    }
    if ((window.innerWidth || 0) < 700) target = Math.min(target, 14);
    state.target = target;
    state.petals = (state.enabled && !state.reduced) ? target : 0;
    if (state.baked) syncPetals();
  }

  function applyAssociation(reason) {
    var next = readAssociation();
    var prev = state.cardCount;
    var increased = state.countReady && next.count > prev;
    state.cardCount = next.count;
    state.pinned = next.pinned;
    state.quiet = next.quiet;
    state.countReady = true;
    if (dom.front) {
      dom.front.setAttribute('data-state', state.quiet ? 'quiet' : (next.count >= 8 || next.pinned > 0 ? 'rich' : 'normal'));
    }
    updatePetalTarget();
    if (increased && state.enabled && state.pageActive) {
      bloom(Math.min(3, Math.max(1, Math.round((next.count - prev) / 2))));
    }
  }

  function scheduleCount() {
    if (countTimer) clearTimeout(countTimer);
    countTimer = setTimeout(function () {
      countTimer = 0;
      try { applyAssociation('mutation'); } catch (e) { softFail(e, 'association'); }
    }, COUNT_DEBOUNCE);
  }

  function resonance(source, force) {
    try {
      if (!dom.front) return;
      if (!force) {
        if (!state.enabled || state.reduced || !state.pageActive) return;
        var stamp = now();
        if (stamp - state.lastResonance < RESONANCE_THROTTLE) return;
        state.lastResonance = stamp;
      }
      var pinned = !!(source && source.classList && source.classList.contains('mem-pinned'));
      dom.front.classList.remove('is-resonating');
      DOM_REFLOW(dom.front);
      dom.front.classList.toggle('is-resonating-pinned', pinned);
      dom.front.classList.add('is-resonating');
      if (state.resonanceTimer) clearTimeout(state.resonanceTimer);
      state.resonanceTimer = setTimeout(function () {
        state.resonanceTimer = 0;
        if (!dom.front) return;
        dom.front.classList.remove('is-resonating');
        dom.front.classList.remove('is-resonating-pinned');
      }, RESONANCE_MS + 100);
      releasePetals(pinned ? 2 : 1, pinned);
    } catch (e) {
      softFail(e, 'resonance');
    }
  }

  function bloom(size) {
    try {
      if (!state.enabled || state.reduced) return;
      if (state.baked) {
        releasePetals(Math.min(3, Math.max(1, size || 1)));
      }
    } catch (e) {
      softFail(e, 'bloom');
    }
  }

  /* 强制读取布局以重启动画（节流后才会走到这里，成本可接受）。 */
  function DOM_REFLOW(el) {
    try { return el && el.offsetWidth; } catch (e) { return 0; }
  }

  /* --------------------------------------------------------- 开关 / 持久化 */

  function persistEnabled(on) {
    try {
      if (window.localStorage) localStorage.setItem(STORE_KEY, on ? 'on' : 'off');
    } catch (e) { /* 隐私模式 / file:// 下静默失败 */ }
  }

  function readEnabled() {
    try {
      if (!window.localStorage) return true;
      return localStorage.getItem(STORE_KEY) !== 'off';
    } catch (e) {
      return true;
    }
  }

  function applyEnabledFlags() {
    var value = state.enabled ? 'true' : 'false';
    if (dom.back) dom.back.setAttribute('data-enabled', value);
    if (dom.front) dom.front.setAttribute('data-enabled', value);
    if (dom.toggle) {
      dom.toggle.setAttribute('aria-pressed', value);
      dom.toggle.title = state.enabled
        ? '氛围层 · Atmosphere（显示中，点击隐藏）'
        : '氛围层 · Atmosphere（已隐藏，点击显示）';
    }
  }

  function setEnabled(on) {
    on = !!on;
    if (state.enabled === on) { applyEnabledFlags(); return; }
    state.enabled = on;
    state.toggles++;
    persistEnabled(on);
    try {
      applyEnabledFlags();
      if (on) ensureBaked();
      syncPlayback();
      if (on && state.pageActive) scheduleFrame();
    } catch (e) {
      softFail(e, 'enabled');
    }
  }

  function toggle() {
    try {
      setEnabled(!state.enabled);
      return state.enabled;
    } catch (e) {
      softFail(e, 'toggle');
      return state.enabled;
    }
  }

  /* ------------------------------------------------------------- 生命周期 */

  function syncPlayback() {
    var active = !!state.pageActive;
    var pausedCss = !active || !state.enabled || document.hidden;
    if (dom.front) {
      dom.front.classList.toggle('is-page', active);
      dom.front.classList.toggle('is-paused', pausedCss);
    }
    if (dom.back) {
      dom.back.classList.toggle('is-page', active);
      dom.back.classList.toggle('is-paused', pausedCss);
    }
    var canRun = active && state.enabled && !document.hidden && !state.reduced;
    if (canRun && state.baked) startPetals();
    else stopPetals();
    state.paused = !canRun;
  }

  function ensureBaked() {
    if (state.baked) return;
    try {
      palette = buildPalette();
      state.dark = palette.dark;
      bakeBough();
      bakeBack();
      bakePetalSprites();
      layoutPetals();
      state.baked = true;
      updatePetalTarget();
    } catch (e) {
      softFail(e, 'bake');
    }
  }

  function rebake() {
    try {
      palette = buildPalette();
      state.dark = palette.dark;
      if (!state.baked) return;
      bakeBough();
      bakeBack();
      bakePetalSprites();
      /* 主题交叉淡入期间枝条保持旧图直到新图写入；无需重建实例。 */
    } catch (e) {
      softFail(e, 'rebake');
    }
  }

  function syncPageState() {
    try {
      if (!page) return;
      var active = page.classList.contains('active');
      if (active === state.pageActive) return;
      state.pageActive = active;
      if (active) {
        ensureBaked();
        applyAssociation('activate');
        if (state.w === 0 || state.h === 0) layoutPetals();
      }
      syncPlayback();
    } catch (e) {
      softFail(e, 'page-state');
    }
  }

  function scheduleTheme() {
    if (themePending) return;
    themePending = true;
    var run = function () {
      themePending = false;
      var dark = isDarkTheme();
      if (dark === state.dark) return;
      rebake();
    };
    if (window.requestAnimationFrame) themeRaf = requestAnimationFrame(run);
    else themeRaf = setTimeout(run, 60);
  }

  function scheduleResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = 0;
      try {
        if (!state.baked) return;
        bakeBack();
        layoutPetals();
        if (state.pageActive && state.enabled && !state.reduced && !document.hidden) startPetals();
      } catch (e) {
        softFail(e, 'resize');
      }
    }, 200);
  }

  function onVisibility() {
    syncPlayback();
    if (!document.hidden && state.pageActive && state.enabled && !state.reduced) startPetals();
  }

  function onReducedChange() {
    try {
      state.reduced = !!(reduceQuery && reduceQuery.matches);
      if (state.reduced) {
        state.petals = 0;
        stopPetals(true);
      } else {
        updatePetalTarget();
      }
      syncPlayback();
    } catch (e) {
      softFail(e, 'reduced');
    }
  }

  /* -------------------------------------------------------------- 挂载 */

  function revealLayers() {
    try {
      if (dom.back) dom.back.hidden = false;
      if (dom.front) dom.front.hidden = false;
      if (dom.row) dom.row.hidden = false;
    } catch (e) { /* noop */ }
  }

  function injectStyles() {
    var existing = document.getElementById(CSS_ID);
    if (existing) return existing;
    var link = document.createElement('link');
    link.id = CSS_ID;
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    /* 监听器先于 append 注册，避免极快缓存命中时错过 load 事件。 */
    link.addEventListener('load', function () { revealLayers(); }, { once: true });
    link.addEventListener('error', function () { /* 样式缺失即永久隐藏图层 */ }, { once: true });
    document.head.appendChild(link);
    return link;
  }

  /* 样式表尚未落地时两个 fixed 图层先带 hidden 属性，避免任何「未加样式」的
     瞬时占位/闪烁；样式就绪后再移除 hidden。样式文件缺失时图层永久隐藏 ——
     氛围层静默缺席，页面照常工作。 */
  function revealWhenStyled(link) {
    try {
      if (!link) { revealLayers(); return; }
      if (link.sheet) { revealLayers(); return; }
      setTimeout(function () {
        try { if (link.sheet) revealLayers(); } catch (e) { /* noop */ }
      }, 700);
    } catch (e) {
      revealLayers();
    }
  }

  function ensureProbe() {
    if (probe || !document.body) return;
    probe = document.createElement('span');
    probe.id = 'ib-mem-atmos-probe';
    probe.className = 'ib-mem-atmos__probe';
    probe.setAttribute('aria-hidden', 'true');
    document.body.appendChild(probe);
  }

  function buildDom() {
    var back = document.createElement('div');
    back.id = BACK_ID;
    back.className = 'ib-mem-atmos__layer ib-mem-atmos__back';
    back.setAttribute('aria-hidden', 'true');
    back.setAttribute('data-enabled', 'true');
    back.hidden = true;
    var nebula = document.createElement('canvas');
    nebula.className = 'ib-mem-atmos__nebula';
    nebula.setAttribute('aria-hidden', 'true');
    var motes = document.createElement('canvas');
    motes.className = 'ib-mem-atmos__motes';
    motes.setAttribute('aria-hidden', 'true');
    back.appendChild(nebula);
    back.appendChild(motes);

    var front = document.createElement('div');
    front.id = FRONT_ID;
    front.className = 'ib-mem-atmos__layer ib-mem-atmos__front';
    front.setAttribute('data-enabled', 'true');
    front.setAttribute('data-state', 'quiet');
    front.hidden = true;

    var boughMain = document.createElement('img');
    boughMain.className = 'ib-mem-atmos__bough ib-mem-atmos__bough--main';
    boughMain.alt = '';
    boughMain.draggable = false;
    boughMain.setAttribute('aria-hidden', 'true');
    boughMain.setAttribute('decoding', 'async');

    var boughFar = document.createElement('img');
    boughFar.className = 'ib-mem-atmos__bough ib-mem-atmos__bough--far';
    boughFar.alt = '';
    boughFar.draggable = false;
    boughFar.setAttribute('aria-hidden', 'true');
    boughFar.setAttribute('decoding', 'async');

    var reson = document.createElement('div');
    reson.className = 'ib-mem-atmos__resonance';
    reson.setAttribute('aria-hidden', 'true');

    var petalCanvas = document.createElement('canvas');
    petalCanvas.className = 'ib-mem-atmos__petals';
    petalCanvas.setAttribute('aria-hidden', 'true');

    front.appendChild(boughFar);
    front.appendChild(boughMain);
    front.appendChild(reson);
    front.appendChild(petalCanvas);

    document.body.appendChild(back);
    document.body.appendChild(front);

    dom.back = back;
    dom.nebula = nebula;
    dom.motes = motes;
    dom.front = front;
    dom.boughMain = boughMain;
    dom.boughFar = boughFar;
    dom.resonance = reson;
    dom.petals = petalCanvas;
  }

  /* 开关属于页面内容，不是视口浮层：插进 #page-memory .module-intro，
     跟在「收藏夹 · Favorites」之后，因此永远不会覆盖统计条、卡片或工具条。
     进入/离开 Memory 页由页面自身 display 切换，无需额外显隐逻辑。 */
  function buildToggle() {
    try {
      var intro = document.querySelector('#page-memory .module-intro');
      if (!intro) return;
      var row = document.createElement('div');
      row.className = 'ib-mem-atmos__control-row';
      row.hidden = true;

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'ib-mem-atmos-toggle';
      btn.className = 'ib-mem-atmos__toggle';
      btn.setAttribute('aria-pressed', 'true');
      btn.setAttribute('aria-label', '氛围层 Atmosphere — 显示或隐藏记忆页氛围');
      btn.title = '氛围层 · Atmosphere（显示中，点击隐藏）';

      var dot = document.createElement('span');
      dot.className = 'ib-mem-atmos__toggle-dot';
      dot.setAttribute('aria-hidden', 'true');
      var label = document.createElement('span');
      label.className = 'ib-mem-atmos__toggle-label';
      label.textContent = 'Atmosphere';

      btn.appendChild(dot);
      btn.appendChild(label);
      row.appendChild(btn);

      var fav = document.getElementById('mem-favorites-link');
      if (fav && fav.parentNode === intro) intro.insertBefore(row, fav.nextSibling);
      else intro.appendChild(row);

      dom.row = row;
      dom.toggle = btn;
      dom.dot = dot;
      dom.label = label;

      btn.addEventListener('click', function (ev) {
        try {
          if (ev && ev.preventDefault) ev.preventDefault();
          toggle();
        } catch (e) {
          softFail(e, 'toggle-click');
        }
      });
    } catch (e) {
      softFail(e, 'toggle-build');
    }
  }

  function bindObservers() {
    page = page || document.getElementById('page-memory');
    list = list || document.getElementById('mem-list');

    if (page && window.MutationObserver) {
      var pageObs = new MutationObserver(function () { syncPageState(); });
      pageObs.observe(page, { attributes: true, attributeFilter: ['class'] });
    }

    if (list && window.MutationObserver) {
      var listObs = new MutationObserver(function () { scheduleCount(); });
      listObs.observe(list, { childList: true, subtree: true });
    }

    if (document.body && window.MutationObserver) {
      var bodyObs = new MutationObserver(function () { scheduleTheme(); });
      bodyObs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    window.addEventListener('resize', scheduleResize);
    document.addEventListener('visibilitychange', onVisibility);

    if (reduceQuery) {
      if (typeof reduceQuery.addEventListener === 'function') reduceQuery.addEventListener('change', onReducedChange);
      else if (typeof reduceQuery.addListener === 'function') reduceQuery.addListener(onReducedChange);
    }

    /* 弱关联：委托在页面上，只读卡片 class，不做任何数据/状态写入。 */
    if (page) {
      var onHover = function (ev) {
        try {
          var el = ev && ev.target;
          var card = el && el.closest ? el.closest('.mem-card') : null;
          if (card) resonance(card, false);
        } catch (e) { /* 静默：hover 只是视觉暗示 */ }
      };
      page.addEventListener('pointerover', onHover, { passive: true });
      page.addEventListener('mouseover', onHover, { passive: true });
      page.addEventListener('focusin', onHover, true);
    }
  }

  function softFail(error, where) {
    try {
      var message = String(error && error.message ? error.message : error);
      if (!state.lastError) state.lastError = (where ? where + ': ' : '') + message;
      if (dom.petals) dom.petals.setAttribute('data-error', 'true');
      if (dom.front) dom.front.setAttribute('data-error', 'true');
    } catch (e) { /* 连失败处理都失败时保持静默 */ }
  }

  /* IB.expose() 是属性拷贝（见 ib-namespace.js）：mount 后必须重新导出一次，
     否则 window.IB.memoryAtmosphere.mounted 会停留在脚本注册时的 false 快照。 */
  function exposeApi() {
    try {
      if (NS && typeof NS.expose === 'function') NS.expose('memoryAtmosphere', api);
      else NS.memoryAtmosphere = api;
    } catch (e) {
      try { NS.memoryAtmosphere = api; } catch (e2) { /* 命名空间不可写时保持静默 */ }
    }
  }

  function mount() {
    if (state.mounted) return api;
    var started = now();
    try {
      var styleLink = injectStyles();
      ensureProbe();
      page = document.getElementById('page-memory');
      list = document.getElementById('mem-list');
      if (!document.body) return api;
      buildDom();
      buildToggle();
      applyEnabledFlags();
      revealWhenStyled(styleLink);

      reduceQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
      state.reduced = !!(reduceQuery && reduceQuery.matches);

      bindObservers();

      page = page || document.getElementById('page-memory');
      state.pageActive = !!(page && page.classList.contains('active'));
      if (state.pageActive) {
        ensureBaked();
        applyAssociation('mount');
      } else {
        /* 未激活也要知道卡片基线，避免首次进入时就误判为「新增卡片」。 */
        applyAssociation('mount');
      }
      syncPlayback();
      state.mounted = true;
      api.mounted = true;
      state.mountMs = Math.round((now() - started) * 100) / 100;
      exposeApi();
    } catch (e) {
      softFail(e, 'mount');
      state.mounted = true;
      api.mounted = true;
      exposeApi();
    }
    return api;
  }

  /* ---------------------------------------------------------------- API */

  var api = {
    version: VERSION,
    role: 'PRESENTATION_LAYER_ONLY',
    dataRead: 'DOM_ONLY (.mem-card / .empty-state / pinned)',
    storageKey: STORE_KEY,
    mounted: false,
    mount: mount,
    enabled: function () { return state.enabled; },
    setEnabled: function (on) { setEnabled(on); return state.enabled; },
    toggle: toggle,
    stats: function () {
      try {
        return {
          mounted: state.mounted,
          version: VERSION,
          enabled: state.enabled,
          pageActive: state.pageActive,
          paused: state.paused,
          reduced: state.reduced,
          petals: (state.enabled && !state.reduced) ? state.petals : 0,
          motes: state.motes,
          dpr: Math.round(state.dpr * 100) / 100,
          width: state.w,
          height: state.h,
          frames: state.frames,
          approxFps: Math.round(state.fps * 10) / 10,
          mountMs: state.mountMs,
          lastError: state.lastError,
          toggles: state.toggles
        };
      } catch (e) {
        return {
          mounted: state.mounted, version: VERSION,
          enabled: state.enabled, pageActive: state.pageActive, paused: state.paused,
          reduced: state.reduced, petals: 0, motes: 0, dpr: 1, width: 0, height: 0,
          frames: state.frames, approxFps: 0, mountMs: state.mountMs,
          lastError: state.lastError || 'stats failed', toggles: state.toggles
        };
      }
    },
    debug: {
      resonance: function (pinned) {
        resonance(null, true);
        if (pinned && dom.front) dom.front.classList.add('is-resonating-pinned');
        return true;
      },
      bloom: function () { bloom(3); return true; },
      rebake: function () { rebake(); return true; }
    },
    _internals: {
      PETAL_BASE: PETAL_BASE,
      PETAL_CAP: PETAL_CAP,
      PETAL_QUIET: PETAL_QUIET,
      storeKey: STORE_KEY
    }
  };

  /* 初始化：任何一步失败都不得向页面抛错；最坏情况是氛围层缺席。 */
  try {
    state.enabled = readEnabled();
    state.reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) {
    state.enabled = true;
    state.reduced = false;
  }

  exposeApi();

  try {
    if (document.body && document.getElementById('page-memory')) {
      /* 脚本在页面末尾注入，DOM 已就绪时立即挂载：不给验收/首屏留异步竞态。 */
      mount();
    } else if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { try { mount(); } catch (e) { softFail(e, 'mount'); } }, { once: true });
    } else {
      mount();
    }
  } catch (e) {
    softFail(e, 'boot');
  }
})(window.IB || (window.IB = {}));
