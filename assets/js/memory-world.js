/* ============================================================================
   UI-P1 · Memory World / 记忆世界
   ----------------------------------------------------------------------------
   ROLE ................ PRESENTATION_LAYER_ONLY
   DATA AUTHORITY ...... window.dbGetAll('memories')  （既有唯一读路径）
   DURABLE WRITES ...... 0
   ASSOCIATION LINES ... DISABLED（Runtime Association 不由本 UI 持有或可视化）
   POSITION SEMANTICS .. 无（确定性布局，仅视觉）
   COGNITIVE STATE ..... NONE（不读 Interpretation / Expectation /
                         BehaviorEffect / MetaMemory 私有状态）

   本模块只做三件事：
     1. 在 Memory 页插入一个「世界入口」（读取既有 memory 事实，画在 canvas 上）；
     2. 点击进入一个全屏世界（同一个确定性布局，可选中、可退出）；
     3. 选中后在 bounded preview 里显示真实字段，并把「打开记忆」交回既有
        detail/edit authority（window.openMemoryModal）。

   明确不做：
     · 不写 memory_records / canonical memory / activation / importance /
       visibility / recall / score / MetaMemory / relationship / persona。
     · 不用文本相似度或标签相似度自动连线，不生成 pseudo graph。
     · 不在节点上做无限脉动；主世界背景静止，仅入口展示窗缓慢潮涌。
     · 不创建第二份 memory authority / cache / IndexedDB store。

   编码约束（见 docs/architecture/IB_VISUAL_TOKEN_CONTRACT_V1.md 与
   scripts/ui-guardrail.js）：本文件不含任何内联样式属性赋值；视觉值全部走
   CSS 类与 CSS 自定义属性。
   ============================================================================ */
(function (NS) {
  'use strict';

  var CSS_HREF = 'assets/css/memory-world.css';
  var CSS_ID = 'ib-memory-world-style';
  var VERSION = 'ui-p1.1';
  var FALLBACK_TITLE = '无标题记忆';

  var state = {
    mounted: false,
    pageHooked: false,
    entered: false,
    open: false,
    ready: false,
    loading: false,
    historyPushed: false,
    returnFocus: null,
    selectedId: null,
    hoverId: null,
    items: [],
    nodes: [],
    fingerprint: '',
    renderMs: 0,
    renderedNodes: 0,
    finderOpen: false,
    menuOpen: false,
    finderQuery: '',
    motion: true,
    envOn: true,
    lastError: null
  };

  var dom = {};
  var surfaces = [];
  var palette = null;
  var probe = null;
  var reduceQuery = null;

  /* ------------------------------------------------------------------ util */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function num(v, fallback) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : fallback;
  }

  function text(v) {
    if (v === null || v === undefined) return '';
    return String(v);
  }

  /* FNV-1a + 雪崩终结。memory-sky 的散列在一维上会退化（相邻 id 落成一条斜线），
     这里补上终结混合，保证 x/y 两个通道相互独立。 */
  function hash32(str) {
    var h = 2166136261 >>> 0;
    var s = String(str);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= h >>> 16;
    h = Math.imul(h, 2246822507) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 3266489909) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }

  function unit(id, salt) { return hash32(String(id) + '~' + salt) / 4294967296; }

  function seeded(seed) {
    var s = seed >>> 0;
    return function () {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /* --------------------------------------------------------- 数据（只读） */

  function normalizeRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var id = raw.id === null || raw.id === undefined ? '' : String(raw.id);
    if (!id) return null;
    var created = num(raw.created, num(raw.createdAt, 0));
    return {
      id: id,
      title: text(raw.title).trim(),
      summary: text(raw.summary).trim(),
      content: text(raw.content).trim(),
      oneLine: text(raw.oneLine).trim(),
      domain: text(raw.domain).trim() || text(raw.rawSource).trim(),
      tags: Array.isArray(raw.tags) ? raw.tags.map(text) : [],
      importance: clamp(Math.round(num(raw.importance, 5)), 1, 10),
      pinned: raw.pinned === true,
      resolved: raw.resolved === true,
      created: created > 0 ? created : 0,
      /* 仅用于视觉权重的既有派生值；不是权威事实，也不显示为数字。 */
      vitality: vitalityOf(raw),
      /* 视觉权重与视觉层级：presentation-only，derive 自真实字段。 */
      visualWeight: 0,
      tier: 'speck',
      raw: raw
    };
  }

  /* 复用既有只读原语 window.getMemVitality（memory/constellations.js）。
     它是表现层派生值（pinned / lastActivated / resolved / activationCount），
     不是权威 telemetry；异常或缺失时退回中性值。 */
  function vitalityOf(raw) {
    var fn = window.getMemVitality;
    if (typeof fn === 'function') {
      try {
        var v = fn(raw);
        if (isFinite(v)) return clamp(v, 0.12, 1);
      } catch (e) { /* 保持静默：视觉权重不能因为派生值异常而中断 */ }
    }
    return 0.5;
  }

  function readMemories() {
    var reader = window.dbGetAll;
    if (typeof reader !== 'function') {
      return Promise.resolve([]);
    }
    return Promise.resolve(reader('memories')).then(function (rows) {
      if (!Array.isArray(rows)) return [];
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var rec = normalizeRecord(rows[i]);
        if (rec) out.push(rec);
      }
      return out;
    });
  }

  /* --------------------------------------------------- 确定性布局（视觉） */
  /* 位置只由 memory.id 的散列决定，与题材无关：
       POSITION_HAS_SEMANTIC_AUTHORITY = NO
     同一集合重复渲染得到同一布局；不同 id 得到合理分散。 */

  var LAYOUT_MARGIN = 0.06;

  function computeLayout(items) {
    var nodes = [];
    var i;
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      nodes.push({
        id: it.id,
        ux: unit(it.id, 'layout-x'),
        uy: unit(it.id, 'layout-y'),
        x: 0,
        y: 0
      });
    }
    /* 稳定顺序：确定性要求处理顺序与输入顺序无关。 */
    nodes.sort(function (a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });
    var n = nodes.length;
    for (i = 0; i < n; i++) {
      nodes[i].x = LAYOUT_MARGIN + nodes[i].ux * (1 - 2 * LAYOUT_MARGIN);
      nodes[i].y = LAYOUT_MARGIN + nodes[i].uy * (1 - 2 * LAYOUT_MARGIN);
    }
    if (n < 2) return nodes;

    var minDist = clamp(0.5 / Math.sqrt(n), 0.02, 0.09);
    var passes = 3;
    for (var pass = 0; pass < passes; pass++) {
      var grid = {};
      var cell = minDist;
      for (i = 0; i < n; i++) {
        var bx = Math.floor(nodes[i].x / cell);
        var by = Math.floor(nodes[i].y / cell);
        var key = bx + ',' + by;
        (grid[key] || (grid[key] = [])).push(i);
      }
      for (i = 0; i < n; i++) {
        var a = nodes[i];
        var cx = Math.floor(a.x / cell);
        var cy = Math.floor(a.y / cell);
        var px = 0;
        var py = 0;
        for (var ox = -1; ox <= 1; ox++) {
          for (var oy = -1; oy <= 1; oy++) {
            var bucket = grid[(cx + ox) + ',' + (cy + oy)];
            if (!bucket) continue;
            for (var k = 0; k < bucket.length; k++) {
              var j = bucket[k];
              if (j === i) continue;
              var b = nodes[j];
              var dx = a.x - b.x;
              var dy = a.y - b.y;
              var d2 = dx * dx + dy * dy;
              if (d2 >= minDist * minDist) continue;
              var d = Math.sqrt(d2);
              if (d < 1e-6) {
                /* 完全重合时用 id 的散列给出一个确定方向，而不是随机数。 */
                var ang = unit(a.id, 'layout-sep') * 6.283185;
                px += Math.cos(ang) * minDist;
                py += Math.sin(ang) * minDist;
              } else {
                var push = (minDist - d) / d * 0.5;
                px += dx * push;
                py += dy * push;
              }
            }
          }
        }
        a.x = clamp(a.x + px, LAYOUT_MARGIN, 1 - LAYOUT_MARGIN);
        a.y = clamp(a.y + py, LAYOUT_MARGIN, 1 - LAYOUT_MARGIN);
      }
    }
    return nodes;
  }

  function layoutFingerprint(nodes, items) {
    var parts = [];
    for (var i = 0; i < nodes.length; i++) {
      parts.push(nodes[i].id + ':' + nodes[i].x.toFixed(4) + ':' + nodes[i].y.toFixed(4));
    }
    return hash32(parts.join('|') + '/' + items.length).toString(16);
  }

  function indexById() {
    state.byId = {};
    for (var i = 0; i < state.items.length; i++) state.byId[state.items[i].id] = state.items[i];
  }

  /* ------------------------------------------------------------- 调色板 */
  /* canvas 需要具体颜色值。这里让浏览器替我们解析语义 token（var() 与
     color-mix() 都会在 computed style 上落地），因此 CSS 不需要出现裸色值。 */

  function parseColor(value) {
    var m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/i.exec(String(value || ''));
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  }

  /* 自定义属性是否真的存在：getPropertyValue 对未声明角色返回空串。
     这一点很关键 —— 直接把 color 设成 var(未声明角色) 会静默变成 inherit，
     于是「解析成功」却拿到继承色（UI-P1 首轮在 bare HEAD 上量到的正是这个）。 */
  function cssVarValue(name) {
    if (!probe) return '';
    try { return String(getComputedStyle(probe).getPropertyValue(name) || '').trim(); } catch (e) { return ''; }
  }

  function colorFromVar(name) {
    if (!probe || !cssVarValue(name)) return null;
    try {
      probe.style.color = '';
      probe.style.color = 'var(' + name + ')';
      return parseColor(getComputedStyle(probe).color);
    } catch (e) {
      return null;
    }
  }

  /* 语义角色优先；该角色缺席时退回它桥接的既有原语（IB Visual Token Contract v1
     §5 的 alias-first 策略）。当前工作树有 D1 token 层；更早的树上没有，
     这条链路让模块在两代树上都成立，而不是靠 token 层「碰巧在场」。 */
  function roleColor(role, legacyLight, legacyDark, fallback) {
    var dark = isDarkTheme();
    var value = colorFromVar(role);
    if (value) return value;
    var legacy = dark ? (legacyDark || legacyLight) : legacyLight;
    var fromLegacy = legacy ? colorFromVar(legacy) : null;
    return fromLegacy || fallback;
  }

  function isDarkTheme() {
    return !!(document.body && document.body.classList.contains('theme-infernal'));
  }

  function mix(a, b, t) {
    return {
      r: a.r + (b.r - a.r) * t,
      g: a.g + (b.g - a.g) * t,
      b: a.b + (b.b - a.b) * t,
      a: (a.a === undefined ? 1 : a.a) + ((b.a === undefined ? 1 : b.a) - (a.a === undefined ? 1 : a.a)) * t
    };
  }

  function rgba(c, alpha) {
    var a = alpha === undefined ? (c.a === undefined ? 1 : c.a) : alpha;
    return 'rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ',' + (Math.round(a * 1000) / 1000) + ')';
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

  function buildPalette() {
    var dark = isDarkTheme();
    var canvas = roleColor('--ib-token-canvas', '--pale', '--bg-deep',
      dark ? { r: 24, g: 30, b: 50, a: 1 } : { r: 226, g: 233, b: 245, a: 1 });
    var subtle = roleColor('--ib-token-canvas-subtle', '--white', '--bg-mid', canvas);
    var ink = roleColor('--ib-token-content-primary', '--content-primary', '--content-primary',
      dark ? { r: 224, g: 230, b: 242, a: 1 } : { r: 26, g: 50, b: 98, a: 1 });
    var faint = roleColor('--ib-token-content-muted', '--content-muted', '--content-muted',
      dark ? { r: 126, g: 144, b: 178, a: 1 } : { r: 82, g: 111, b: 150, a: 1 });
    var accent = roleColor('--ib-token-accent-brand', '--accent', '--accent',
      dark ? { r: 114, g: 168, b: 216, a: 1 } : { r: 80, g: 128, b: 176, a: 1 });
    var accentHover = roleColor('--ib-token-accent-hover', '--accent-light', '--accent', accent);
    /* 「极少量淡暖」允许从既有语义角色取（status-warning），不新增品牌色、不引入紫色。 */
    var warm = roleColor('--ib-token-status-warning', '--status-warning', '--status-warning',
      { r: 181, g: 138, b: 85, a: 1 });

    /* 暗色主视觉：深蓝黑底 + 青冷光。dark 顶/底刻意都压得很深，
       不是为了「更亮更蓝」，而是为了留出大面积黑场。 */
    var top = dark ? mix(canvas, { r: 40, g: 58, b: 96, a: 1 }, 0.34) : mix(canvas, subtle, 0.88);
    var bottom = dark ? mix(canvas, { r: 4, g: 7, b: 16, a: 1 }, 0.72) : mix(canvas, ink, 0.09);

    var riftGlow = dark
      ? mix(accentHover, { r: 205, g: 232, b: 255, a: 1 }, 0.30)
      : mix(canvas, accent, 0.16);
    var riftBody = dark
      ? mix(riftGlow, { r: 150, g: 196, b: 244, a: 1 }, 0.35)
      : mix(canvas, accent, 0.24);
    var riftRidge = dark
      ? mix({ r: 226, g: 241, b: 255, a: 1 }, warm, 0.22)
      : mix(canvas, ink, 0.30);

    var p = {
      dark: dark,
      canvas: canvas,
      top: top,
      bottom: bottom,
      ink: ink,
      faint: faint,
      accent: accent,
      accentHover: accentHover,
      warm: warm,
      riftGlow: riftGlow,
      riftBody: riftBody,
      riftRidge: riftRidge,
      riftWarm: dark ? mix({ r: 232, g: 244, b: 255, a: 1 }, warm, 0.30) : mix(canvas, ink, 0.18),
      /* 宇宙场景继续从既有主题角色派生，独立于记忆节点配色。 */
      nebula: dark ? mix(accent, riftGlow, 0.24) : mix(canvas, accent, 0.36),
      dust: dark ? mix(ink, accentHover, 0.32) : mix(ink, accent, 0.24),
      orbit: dark ? mix(faint, accent, 0.32) : mix(canvas, accent, 0.46),
      /* 节点亮度锚点：暗场用近白冷光，亮场用深墨。 */
      coreAnchor: dark ? { r: 244, g: 249, b: 255, a: 1 } : mix(ink, { r: 12, g: 26, b: 56, a: 1 }, 0.5),
      spriteCache: {},
      tintCache: {}
    };
    return p;
  }

  /* 领域色只作为「冷光里的色偏」：从既有 MEM_DOMAIN_COLORS 单源读取，再向主题
     强调色收拢，避免第二个品牌色系，也避免引入紫色。 */
  function domainTint(domain) {
    var key = text(domain) || '__none__';
    if (palette.tintCache[key]) return palette.tintCache[key];
    var tint = null;
    var map = window.MEM_DOMAIN_COLORS;
    if (map && typeof map === 'object' && key !== '__none__') {
      var entry = map[key];
      var hex = entry && (entry.c || entry.raw);
      tint = hexToRgb(hex);
    }
    if (!tint) tint = palette.accentHover;
    var cooled = mix(tint, palette.accent, 0.45);
    palette.tintCache[key] = cooled;
    return cooled;
  }

  function nodeColors(item) {
    var tint = domainTint(item.domain);
    if (palette.dark) {
      return {
        halo: tint,
        core: mix(mix(tint, palette.coreAnchor, 0.55), palette.accentHover, 0.2)
      };
    }
    return {
      halo: mix(tint, palette.ink, 0.34),
      core: mix(tint, palette.ink, 0.62)
    };
  }

  /* 光斑精灵只依赖色相，与半径无关：一次生成，多处复用。 */
  function spriteFor(color) {
    var key = Math.round(color.r) + '_' + Math.round(color.g) + '_' + Math.round(color.b);
    if (palette.spriteCache[key]) return palette.spriteCache[key];
    var S = 64;
    var cv = document.createElement('canvas');
    cv.width = S;
    cv.height = S;
    var g = cv.getContext('2d');
    var img = g.createImageData(S, S);
    var d = img.data;
    var c = (S - 1) / 2;
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var dd = Math.sqrt((x - c) * (x - c) + (y - c) * (y - c)) / c;
        var a = Math.exp(-(dd * 2.6) * (dd * 2.6));
        var i = (y * S + x) * 4;
        d[i] = Math.round(color.r);
        d[i + 1] = Math.round(color.g);
        d[i + 2] = Math.round(color.b);
        d[i + 3] = Math.round(clamp(a, 0, 1) * 255);
      }
    }
    g.putImageData(img, 0, 0);
    palette.spriteCache[key] = cv;
    return cv;
  }

  /* ================================================== 环境：断层大形 ===== */
  /* UI-P1.1 · Memory Rift / 记忆断层
     MACRO_ENVIRONMENT_BANDS = 2（deterministic · presentation-only）
     RIFT_BANDS_HAVE_MEMORY_SEMANTICS = NO —— 断层不连接任何两个 memory 节点，
     也不承担 semantic graph；它只是世界的「地形」。 */

  var WORLD_SEED = 0x52f7a1;           /* 固定世界种子：reload 后大结构不变 */

  /* 确定性平滑噪声（哈希插值；世界几何不得使用任何随机源）。 */
  function noise1(x, salt) {
    var i = Math.floor(x);
    var f = x - i;
    var a = unit(WORLD_SEED + ':' + salt + ':' + i, 'n');
    var b = unit(WORLD_SEED + ':' + salt + ':' + (i + 1), 'n');
    var u = f * f * (3 - 2 * f);
    return a + (b - a) * u;
  }

  /* 两条断层都定义在归一化世界坐标 [0,1]²，所以入口 / 全屏 / 移动端看到的是
     同一个世界：纵横比只是拉伸它。移动端（竖屏）会把同一条曲线拉陡，
     于是自然获得「纵向贯穿」的宏观结构，而不是把桌面裁窄。 */
  var RIFT_BANDS = [
    {
      key: 'primary', seed: 0x41f0,
      base: 0.300, amp: [0.185, 0.052], freq: [0.62, 1.55], phase: [0.06, 0.47],
      thickness: 0.082,
      breaks: [[0.315, 0.360], [0.655, 0.700]],
      particleDensity: 2600, glow: 1.0
    },
    {
      key: 'secondary', seed: 0x7c3b,
      base: 0.735, amp: [0.085, 0.030], freq: [0.42, 1.15], phase: [0.58, 0.12],
      thickness: 0.048,
      breaks: [[0.135, 0.195]],
      particleDensity: 5200, glow: 0.60
    }
  ];

  function bandY(band, x) {
    return band.base
      + band.amp[0] * Math.sin(6.283185 * (band.freq[0] * x + band.phase[0]))
      + band.amp[1] * Math.sin(6.283185 * (band.freq[1] * x + band.phase[1]));
  }

  function bandThickness(band, x) {
    return band.thickness * (0.55 + 0.95 * noise1(x * 9.0, band.key + ':t'));
  }

  /* 断裂：段内平滑消失（不是硬切口）。 */
  function bandMask(band, x) {
    var m = 1;
    for (var i = 0; i < band.breaks.length; i++) {
      var a = band.breaks[i][0];
      var b = band.breaks[i][1];
      if (x > a && x < b) {
        var t = (x - a) / (b - a);
        m *= clamp(Math.abs(t - 0.5) * 2.6, 0, 1);
      }
    }
    return clamp(m, 0, 1);
  }

  function edgeFadeT(x) {
    /* 两端淡出，避免断层在画面边缘被「切断」得像一条线。 */
    return clamp(Math.min(x, 1 - x) / 0.09, 0, 1);
  }

  /* 脊的亮度沿 x 变化：有的地方结成亮核，有的地方化进雾里 ——
     这是让断层像「地形」而不是一条矢量线的关键。 */
  function ridgeCore(band, x) {
    var n = noise1(x * 5.6, band.key + ':r');
    var n2 = noise1(x * 17.0, band.key + ':r2');
    return 0.22 + 1.30 * n * n * (0.7 + 0.5 * n2);
  }

  function sampleBand(band, W, H, steps) {
    var pts = [];
    for (var i = 0; i <= steps; i++) {
      var x = i / steps;
      var rawY = bandY(band, x);
      var y = clamp(rawY, 0.02, 0.98);
      /* 纵向也淡出：断层不会以满亮度撞进画面的上下边缘。 */
      var vy = clamp(Math.min(rawY, 1 - rawY) / 0.10, 0, 1);
      pts.push({
        x: x * W,
        y: y * H,
        m: bandMask(band, x) * edgeFadeT(x) * vy,
        t: bandThickness(band, x),
        r: ridgeCore(band, x)
      });
    }
    return pts;
  }

  /* 多遍描边叠出「外晕 → 体 → 亮脊」。刻意不用 ctx.filter 模糊：
     整幅画布上做 blur 的代价不可控，而分段描边的成本是线性的、可预算的。 */
  function strokeBandPass(ctx, pts, width, alpha, color, thicknessRef, ridgePass) {
    if (alpha <= 0) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    /* 宽雾层整条绘制一次：半透明分段 round-cap 会叠出串珠状圆斑。 */
    if (width > 3) {
      var wash = ctx.createLinearGradient(0, 0, pts[pts.length - 1].x, 0);
      for (var j = 0; j < pts.length; j++) {
        wash.addColorStop(j / (pts.length - 1), rgba(color, alpha * pts[j].m * (0.6 + pts[j].t / thicknessRef * 0.4)));
      }
      ctx.strokeStyle = wash;
      ctx.globalAlpha = 1;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
      ctx.stroke();
      return;
    }
    ctx.strokeStyle = rgba(color, 1);
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1];
      var b = pts[i];
      var m = (a.m + b.m) * 0.5;
      if (m <= 0.002) continue;
      var t = (a.t + b.t) * 0.5;
      var r = ridgePass ? (a.r + b.r) * 0.5 : 1;
      ctx.globalAlpha = clamp(alpha * m * r, 0, 1);
      ctx.lineWidth = Math.max(0.35, width * (0.55 + (t / thicknessRef) * 0.55) * (ridgePass ? (0.7 + 0.5 * r) : 1));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  function paintRift(ctx, band, W, H, scale) {
    var pts = sampleBand(band, W, H, 84);
    var dark = palette.dark;
    var g = band.glow;

    if (dark) {
      strokeBandPass(ctx, pts, 164 * scale, 0.012 * g, palette.nebula, band.thickness);
      strokeBandPass(ctx, pts, 130 * scale, 0.016 * g, palette.nebula, band.thickness);
      strokeBandPass(ctx, pts, 96 * scale, 0.020 * g, palette.nebula, band.thickness);
      strokeBandPass(ctx, pts, 68 * scale, 0.025 * g, palette.riftGlow, band.thickness);
      strokeBandPass(ctx, pts, 46 * scale, 0.030 * g, palette.riftGlow, band.thickness);
      strokeBandPass(ctx, pts, 28 * scale, 0.030 * g, palette.riftBody, band.thickness);
      strokeBandPass(ctx, pts, 14 * scale, 0.030 * g, palette.riftBody, band.thickness);
      /* 远处的潮线融入雾带，冷白亮度留给真实记忆点。 */
      strokeBandPass(ctx, pts, 2.1 * scale, 0.055 * g, palette.riftBody, band.thickness);
      strokeBandPass(ctx, pts, 0.8 * scale, 0.19 * g, palette.riftGlow, band.thickness, true);
    } else {
      /* 浅色独立材质：蓝白雾海，淡墨潮线藏在云层里。 */
      strokeBandPass(ctx, pts, 110 * scale, 0.035 * g, palette.nebula, band.thickness);
      strokeBandPass(ctx, pts, 48 * scale, 0.046 * g, palette.riftGlow, band.thickness);
      strokeBandPass(ctx, pts, 16 * scale, 0.055 * g, palette.riftBody, band.thickness);
      strokeBandPass(ctx, pts, 1.0 * scale, 0.23 * g, palette.riftRidge, band.thickness, true);
    }
  }

  /* 断层颗粒聚集：沿线的高斯散布，密度与局部厚度相关。 */
  function paintBandParticles(ctx, band, W, H, scale) {
    var count = Math.min(2200, Math.round((W * H) / band.particleDensity * 2.6));
    if (count <= 0) return;
    var rnd = seeded(band.seed);
    var dark = palette.dark;
    var color = dark ? palette.coreAnchor : mix(palette.ink, palette.canvas, 0.25);
    ctx.fillStyle = rgba(color, 1);
    for (var i = 0; i < count; i++) {
      var x = rnd();
      var m = bandMask(band, x) * edgeFadeT(x);
      var off = (rnd() + rnd() + rnd() - 1.5) / 1.5;      /* 近高斯 */
      var t = bandThickness(band, x);
      if (m <= 0.01) continue;
      var y = clamp(bandY(band, x) + off * t * 1.9, 0.01, 0.99);
      var falloff = Math.exp(-(off * off) * 2.1);
      ctx.globalAlpha = (dark ? 0.055 + rnd() * 0.16 : 0.025 + rnd() * 0.09) * falloff * m * backgroundQuiet(x, y, W);
      var r = (0.23 + Math.pow(rnd(), 2) * 0.48) * scale;
      ctx.beginPath();
      ctx.arc(x * W, y * H, Math.max(0.3, r), 0, 6.283185);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* 非数据性的远景层：固定种子、有限绘制，不订阅时钟或指针。 */
  function backgroundQuiet(x, y, W) {
    var header = 1 - 0.72 * clamp((0.20 - y) / 0.20, 0, 1);
    var foot = clamp((y - 0.62) / 0.30, 0, 1);
    var side = W <= 760 ? 1 : clamp((x - 0.54) / 0.30, 0, 1);
    return header * (1 - 0.82 * foot * side);
  }

  /* 拉长的多停靠点雾斑：边界化开，避免圆盘、滤镜与全屏模糊。 */
  function haze(ctx, x, y, rx, ry, color, alpha, angle) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle || 0);
    ctx.scale(rx, ry);
    var g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, rgba(color, alpha));
    g.addColorStop(0.24, rgba(color, alpha * 0.76));
    g.addColorStop(0.56, rgba(color, alpha * 0.30));
    g.addColorStop(0.82, rgba(color, alpha * 0.06));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }

  function paintSpaceDepth(ctx, W, H) {
    var dark = palette.dark;
    haze(ctx, W * 0.12, H * 0.34, W * 0.56, H * 0.52, palette.nebula, dark ? 0.15 : 0.24, -0.18);
    haze(ctx, W * 0.78, H * 0.28, W * 0.48, H * 0.60, palette.accent, dark ? 0.10 : 0.08, 0.28);
    haze(ctx, W * 0.42, H * 0.75, W * 0.62, H * 0.32, palette.riftGlow, dark ? 0.07 : 0.10, -0.12);
  }

  function paintMist(ctx, W, H) {
    var dark = palette.dark;
    for (var bi = 0; bi < RIFT_BANDS.length; bi++) {
      var band = RIFT_BANDS[bi];
      var rnd = seeded(band.seed ^ 0x5a5a);
      var n = 22;
      for (var i = 0; i < n; i++) {
        var x = (i + rnd() * 0.72) / n;
        var m = bandMask(band, x) * edgeFadeT(x);
        if (m <= 0.05) continue;
        var cx = x * W;
        var cy = clamp(bandY(band, x) + (rnd() - 0.5) * bandThickness(band, x) * 3.0, 0.01, 0.99) * H;
        var rx = (0.075 + rnd() * 0.115) * W;
        var ry = (0.042 + rnd() * 0.072) * H;
        var quiet = backgroundQuiet(x, cy / H, W);
        var a = (dark ? 0.10 + rnd() * 0.095 : 0.12 + rnd() * 0.10) * m * band.glow * quiet;
        haze(ctx, cx, cy, rx, ry, palette.nebula, a, (rnd() - 0.5) * 0.42);
        haze(ctx, cx - rx * 0.22, cy - ry * 0.32, rx * 0.78, ry * 0.38, palette.riftGlow, a * 0.54, -0.14);
        haze(ctx, cx, cy - ry * 0.80, rx * 0.46, ry * 2.2, palette.nebula, a * 0.25, (rnd() - 0.5) * 0.70);
        /* 淡暗尘道把云层分开；浅色以白雾留出清澈的间隙。 */
        haze(ctx, cx + rx * 0.28, cy + ry * 0.52, rx * 0.66, ry * 0.42,
          dark ? palette.bottom : palette.top, a * (dark ? 2.4 : 1.8), 0.12);
      }
    }
  }

  /* 星尘有疏密、大小与亮度差异；小而弱，无光晕，不冒充记忆节点。 */
  function paintFarStars(ctx, W, H, scale) {
    var rnd = seeded(WORLD_SEED ^ 0x2d0c11);
    var n = Math.min(1000, Math.round((W * H) / 1550));
    var dark = palette.dark;
    ctx.fillStyle = rgba(palette.dust, 1);
    for (var i = 0; i < n; i++) {
      var x = rnd();
      var y = rnd();
      if (rnd() < 0.62) y = clamp(bandY(RIFT_BANDS[0], x) + (rnd() + rnd() - 1) * 0.42, 0.01, 0.99);
      var weight = Math.pow(rnd(), 2.6);
      var r = (0.24 + weight * 0.55) * scale;
      ctx.globalAlpha = (dark ? 0.025 + weight * 0.13 : 0.02 + weight * 0.075) * backgroundQuiet(x, y, W);
      ctx.beginPath();
      ctx.arc(x * W, y * H, Math.max(0.23, r), 0, 6.283185);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* 三条远处弧线只表达空间秩序，与节点、标签和关联无关。 */
  function paintOrbitArcs(ctx, W, H) {
    var arcs = [
      [0.26, 0.73, 0.72, 0.52, -0.22, 3.42, 4.86],
      [0.78, 0.32, 0.61, 0.68, 0.28, 1.90, 3.00],
      [0.78, 0.32, 0.64, 0.71, 0.28, 2.03, 2.68]
    ];
    ctx.save();
    ctx.lineWidth = 0.55;
    for (var i = 0; i < arcs.length; i++) {
      var a = arcs[i];
      var g = ctx.createLinearGradient(0, H * 0.08, W, H * 0.76);
      var alpha = (palette.dark ? 0.080 : 0.13) * (i === 2 ? 0.48 : 1);
      g.addColorStop(0, rgba(palette.orbit, 0));
      g.addColorStop(0.30, rgba(palette.orbit, alpha));
      g.addColorStop(0.65, rgba(palette.orbit, alpha * 0.68));
      g.addColorStop(1, rgba(palette.orbit, 0));
      ctx.strokeStyle = g;
      ctx.beginPath();
      ctx.ellipse(a[0] * W, a[1] * H, a[2] * W, a[3] * H, a[4], a[5], a[6]);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* 底色暗角与顶部 / 下缘洗色：装饰退后，透明 annotation 仍可读。 */
  function paintQuietVeil(ctx, W, H) {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    var top = palette.dark ? palette.canvas : palette.top;
    var bottom = palette.dark ? palette.bottom : palette.top;
    g.addColorStop(0, rgba(top, 0.48));
    g.addColorStop(0.22, rgba(top, 0));
    g.addColorStop(0.62, rgba(bottom, 0));
    g.addColorStop(1, rgba(bottom, palette.dark ? 0.70 : 0.64));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /* ------------------------------------------------- 环境层 × 2 张画布 ---- */
  /* env = 深空底色 + 雾带潮线 + 星尘；mist = 星云 + 远星 + 弧线 + 静谧洗色。
     主世界只在尺寸 / 主题 / 数据变化时重绘；CSS 仅让入口展示窗缓慢潮涌。 */

  function paintEnvLayer(cv, W, H) {
    if (!cv || W < 2 || H < 2) return;
    var F = state.fitter(cv);
    var ctx = F.ctx;
    var scale = clamp(Math.min(W, H) / 780, 0.45, 2.4);
    ctx.clearRect(0, 0, W, H);

    var g = ctx.createLinearGradient(0, 0, 0, H);
    if (palette.dark) {
      g.addColorStop(0, rgba(mix(palette.top, palette.bottom, 0.23), 1));
      g.addColorStop(0.42, rgba(mix(palette.canvas, palette.bottom, 0.35), 1));
      g.addColorStop(1, rgba(palette.bottom, 1));
    } else {
      g.addColorStop(0, rgba(palette.top, 1));
      g.addColorStop(0.5, rgba(palette.canvas, 1));
      g.addColorStop(1, rgba(palette.bottom, 1));
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    paintSpaceDepth(ctx, W, H);
    for (var i = 0; i < RIFT_BANDS.length; i++) paintRift(ctx, RIFT_BANDS[i], W, H, scale);
    if (state.envOn) {
      for (var j = 0; j < RIFT_BANDS.length; j++) paintBandParticles(ctx, RIFT_BANDS[j], W, H, scale);
    }
    ctx.globalAlpha = 1;
  }

  function paintMistLayer(cv, W, H) {
    if (!cv || W < 2 || H < 2) return;
    var F = state.fitter(cv);
    var ctx = F.ctx;
    var scale = clamp(Math.min(W, H) / 780, 0.45, 2.4);
    ctx.clearRect(0, 0, W, H);
    if (!state.envOn) return;

    paintMist(ctx, W, H);
    paintFarStars(ctx, W, H, scale);
    paintOrbitArcs(ctx, W, H);
    paintQuietVeil(ctx, W, H);
    ctx.globalAlpha = 1;
  }

  /* ============================================== 记忆节点（视觉分层）== */
  /* 所有 memory 都渲染（renderedNodes === items，永不 sampling）；
     差别只在「视觉权重」。分层完全由真实字段决定，并按分位数压缩，
     所以无论数据分布如何，画面都不会变成一屏同强度的光点。 */

  function visualScore(item) {
    var s = (item.importance / 10) * 0.50 + item.vitality * 0.40;
    if (item.pinned) s += 0.10;
    return clamp(s, 0, 1);
  }

  /* 70% faint specks / 20% lights / 8% stronger / 2% anchors —— 按排名分位，
     排序用 (score desc, id asc) 保证确定性。 */
  function assignTiers(items) {
    var list = items.slice().sort(function (a, b) {
      var sa = a.visualWeight;
      var sb = b.visualWeight;
      if (sa !== sb) return sb - sa;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
    var n = list.length;
    var anchors = Math.round(n * 0.02);
    var strong = Math.round(n * 0.08);
    var light = Math.round(n * 0.20);
    for (var i = 0; i < n; i++) {
      var tier = 'speck';
      if (i < anchors) tier = 'anchor';
      else if (i < anchors + strong) tier = 'strong';
      else if (i < anchors + strong + light) tier = 'light';
      list[i].tier = tier;
    }
    if (n > 0 && anchors === 0) list[0].tier = 'anchor';
  }

  var TIER_STYLE = {
    /* dark: 冷光点 —— 越高层越亮、晕越大。
       UI-P1.1：普通 speck 明显提亮，画面才读得出「有很多记忆」而不是空场；
       同时靠 depth / occlusion / 无光晕把 70% 压在世界里，不靠隐藏。 */
    speck:  { dark: { r: [0.60, 0.95], a: [0.18, 0.32], halo: 0,    core: 0.72 }, light: { r: [0.70, 1.05], a: [0.16, 0.30], halo: 0,    core: 0.70 } },
    light:  { dark: { r: [1.05, 1.65], a: [0.36, 0.54], halo: 2.1,  core: 0.80 }, light: { r: [1.15, 1.75], a: [0.30, 0.48], halo: 0,    core: 0.78 } },
    strong: { dark: { r: [1.90, 2.70], a: [0.60, 0.80], halo: 3.0,  core: 0.92 }, light: { r: [2.00, 2.90], a: [0.54, 0.74], halo: 2.4,  core: 0.88 } },
    anchor: { dark: { r: [3.00, 4.40], a: [0.88, 1.00], halo: 4.2,  core: 1.00 }, light: { r: [3.20, 4.60], a: [0.84, 1.00], halo: 3.4,  core: 0.96 } }
  };

  function depthOf(id) {
    return unit(id, 'depth');
  }

  function paintNodes(surface) {
    var cv = surface.nodes;
    if (!cv) return;
    var W = surface.w;
    var H = surface.h;
    if (W < 2 || H < 2) return;
    var F = state.fitter(cv);
    var ctx = F.ctx;
    ctx.clearRect(0, 0, W, H);
    var nodes = state.nodes;
    /* 空世界也是成功：渲染计数必须如实归零，不能留着上一次的数字。 */
    state.renderedNodes = nodes.length;
    state.renderMs = 0;
    if (!nodes.length) return;

    var scale = clamp(Math.sqrt(W * H) / 950, 0.6, 1.35);
    surface.scale = scale;
    surface.hit = [];
    var dark = palette.dark;
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var item = state.byId[node.id];
      if (!item) continue;
      var x = node.x * W;
      var y = node.y * H;
      var tier = item.tier || 'speck';
      var tierStyle = TIER_STYLE[tier][dark ? 'dark' : 'light'];
      var span = item.visualWeight;

      /* 前后景：同一条数据在三个深度平面上有不同存在感（视差纵深）。 */
      var depth = depthOf(item.id);
      var depthMul = depth < 0.55 ? (dark ? 0.58 : 0.66) : (depth < 0.88 ? 1 : (dark ? 1.14 : 1.08));
      var depthBlur = depth < 0.55 ? 1 : 0;

      /* 局部雾遮蔽：位于断层雾体里的节点被轻微压暗 —— 只做纵深，不做隐藏，
         下限 0.62，任何 memory 都不会因此消失。 */
      var occlusion = 1;
      for (var b = 0; b < RIFT_BANDS.length; b++) {
        var bd = RIFT_BANDS[b];
        var dy = Math.abs(node.y - clamp(bandY(bd, node.x), 0.02, 0.98));
        var reach = bandThickness(bd, node.x) * 2.6;
        if (dy < reach) {
          var near = 1 - dy / reach;
          occlusion = Math.min(occlusion, 1 - 0.38 * near * bandMask(bd, node.x) * edgeFadeT(node.x));
        }
      }

      var radius = (tierStyle.r[0] + (tierStyle.r[1] - tierStyle.r[0]) * span) * scale;
      var alpha = (tierStyle.a[0] + (tierStyle.a[1] - tierStyle.a[0]) * span) * depthMul * occlusion;
      var colors = nodeColors(item);
      var selected = state.selectedId === item.id;
      var hovered = state.hoverId === item.id;

      if (tierStyle.halo > 0 && !depthBlur) {
        var glow = radius * tierStyle.halo;
        ctx.globalAlpha = clamp(alpha * (dark ? 0.85 : 0.55), 0.02, 1);
        ctx.drawImage(spriteFor(colors.halo), x - glow, y - glow, glow * 2, glow * 2);
      }
      if (depthBlur) {
        /* background 平面：略大的柔斑 + 更低的核心，读起来在雾后面。 */
        var soft = radius * 2.6;
        ctx.globalAlpha = clamp(alpha * 0.8, 0.02, 1);
        ctx.drawImage(spriteFor(colors.halo), x - soft, y - soft, soft * 2, soft * 2);
      }

      ctx.globalAlpha = clamp(alpha * tierStyle.core, 0.02, 1);
      ctx.fillStyle = rgba(colors.core, 1);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.45, radius * 0.34), 0, 6.283185);
      ctx.fill();

      /* anchor：最亮的少数才有极淡的衍射十字 —— 视觉锚点，不是装饰。 */
      if (tier === 'anchor' && !depthBlur) {
        var sl = radius * 5.2;
        ctx.globalAlpha = clamp(alpha * (dark ? 0.20 : 0.13), 0, 1);
        ctx.strokeStyle = rgba(dark ? palette.coreAnchor : colors.core, 1);
        ctx.lineWidth = Math.max(0.5, 0.6 * scale);
        ctx.beginPath();
        ctx.moveTo(x - sl, y);
        ctx.lineTo(x - radius * 1.6, y);
        ctx.moveTo(x + radius * 1.6, y);
        ctx.lineTo(x + sl, y);
        ctx.moveTo(x, y - sl);
        ctx.lineTo(x, y - radius * 1.6);
        ctx.moveTo(x, y + radius * 1.6);
        ctx.lineTo(x, y + sl);
        ctx.stroke();
      }

      /* 置顶：发丝细环（把 UI 感降到最低，不抢 selection）。 */
      if (item.pinned) {
        ctx.globalAlpha = clamp(alpha * 0.5, 0.05, 0.55);
        ctx.strokeStyle = rgba(mix(colors.core, palette.accentHover, 0.4), 1);
        ctx.lineWidth = Math.max(0.5, 0.55 * scale);
        ctx.beginPath();
        ctx.arc(x, y, radius * 1.45, 0, 6.283185);
        ctx.stroke();
      }
      if (hovered && !selected) {
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = rgba(palette.accentHover, 1);
        ctx.lineWidth = Math.max(0.6, 0.7 * scale);
        ctx.beginPath();
        ctx.arc(x, y, radius * 2.3, 0, 6.283185);
        ctx.stroke();
      }
      if (selected) {
        /* 只有 selection 是明显的：双环 + 四向刻度都是形状线索。 */
        ctx.globalAlpha = 1;
        ctx.strokeStyle = rgba(palette.accentHover, 1);
        ctx.lineWidth = Math.max(1.2, 1.5 * scale);
        ctx.beginPath();
        ctx.arc(x, y, radius * 2.5, 0, 6.283185);
        ctx.stroke();
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, radius * 3.5, 0, 6.283185);
        ctx.stroke();
        var tick = radius * 5.4;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = Math.max(1, 1.1 * scale);
        ctx.beginPath();
        ctx.moveTo(x - tick, y);
        ctx.lineTo(x - radius * 3.0, y);
        ctx.moveTo(x + radius * 3.0, y);
        ctx.lineTo(x + tick, y);
        ctx.moveTo(x, y - tick);
        ctx.lineTo(x, y - radius * 3.0);
        ctx.moveTo(x, y + radius * 3.0);
        ctx.lineTo(x, y + tick);
        ctx.stroke();
      }

      surface.hit.push({ id: item.id, x: x, y: y, r: Math.max(11, radius * 3.2) });
      ctx.globalAlpha = 1;
    }
    state.renderedNodes = nodes.length;
    state.renderMs = ((window.performance && performance.now) ? performance.now() : Date.now()) - t0;
  }

  /* 入口边缘溶解：画布自己擦掉四边，于是「窗口」不需要边框、圆角或阴影。
     只对入口做（全屏世界没有边）。 */
  function applyEdgeFade(cv, W, H) {
    if (!cv || W < 8 || H < 8) return;
    var F = state.fitter(cv);
    var ctx = F.ctx;
    var fx = clamp(W * 0.075, 18, 110);
    var fy = clamp(H * 0.14, 16, 90);
    ctx.globalCompositeOperation = 'destination-out';
    var gx = ctx.createLinearGradient(0, 0, fx, 0);
    gx.addColorStop(0, 'rgba(0,0,0,1)');
    gx.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gx;
    ctx.fillRect(0, 0, fx, H);
    var gx2 = ctx.createLinearGradient(W, 0, W - fx, 0);
    gx2.addColorStop(0, 'rgba(0,0,0,1)');
    gx2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gx2;
    ctx.fillRect(W - fx, 0, fx, H);
    var gy = ctx.createLinearGradient(0, 0, 0, fy);
    gy.addColorStop(0, 'rgba(0,0,0,1)');
    gy.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gy;
    ctx.fillRect(0, 0, W, fy);
    var gy2 = ctx.createLinearGradient(0, H, 0, H - fy);
    gy2.addColorStop(0, 'rgba(0,0,0,1)');
    gy2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gy2;
    ctx.fillRect(0, H - fy, W, fy);
    ctx.globalCompositeOperation = 'source-over';
  }


  /* ------------------------------------------------------------ 画布尺寸 */

  function fitCanvas(cv) {
    var dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    var box = cv.getBoundingClientRect();
    var W = Math.max(0, Math.round(box.width));
    var H = Math.max(0, Math.round(box.height));
    if (W < 2 || H < 2) {
      var alt = cv.parentElement ? cv.parentElement.getBoundingClientRect() : null;
      if (alt) {
        W = Math.max(0, Math.round(alt.width));
        H = Math.max(0, Math.round(alt.height));
      }
    }
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, dpr: dpr, w: W, h: H };
  }

  state.fitter = fitCanvas;

  function measureSurface(surface) {
    /* 三张画布的盒子各自量：主世界等幅，入口雾层为潮涌留过扫描余量。
       混用尺寸会让绘制坐标与命中测试错位。 */
    var nodes = fitCanvas(surface.nodes);
    surface.w = nodes.w;
    surface.h = nodes.h;
    surface.dpr = nodes.dpr;
    var env = fitCanvas(surface.env);
    surface.envW = env.w;
    surface.envH = env.h;
    if (surface.mist) {
      var mist = fitCanvas(surface.mist);
      surface.mistW = mist.w;
      surface.mistH = mist.h;
    }
  }

  function paintSurface(surface) {
    if (!palette || !surface) return;
    measureSurface(surface);
    if (surface.w < 2 || surface.h < 2) {
      surface.painted = false;
      return;
    }
    if (surface.envW >= 2 && surface.envH >= 2) paintEnvLayer(surface.env, surface.envW, surface.envH);
    if (surface.mist && surface.mistW >= 2 && surface.mistH >= 2) paintMistLayer(surface.mist, surface.mistW, surface.mistH);
    paintNodes(surface);
    if (surface.entry) {
      /* 入口是「世界的一扇窗」：四边在画布里溶解，因此不需要 CSS 边框/圆角/阴影。 */
      applyEdgeFade(surface.env, surface.envW, surface.envH);
      if (surface.mist) applyEdgeFade(surface.mist, surface.mistW, surface.mistH);
      applyEdgeFade(surface.nodes, surface.w, surface.h);
    }
    surface.painted = true;
  }

  function paintAll() {
    if (!state.ready) return;
    for (var i = 0; i < surfaces.length; i++) paintSurface(surfaces[i]);
  }

  function invalidate() {
    palette = null;
    if (!state.ready) return;
    if (probe) palette = buildPalette();
    paintAll();
  }

  /* ---------------------------------------------------------------- 状态 */

  function selectedItem() {
    if (!state.selectedId) return null;
    return state.byId ? (state.byId[state.selectedId] || null) : null;
  }

  function formatDate(ms) {
    var n = num(ms, 0);
    if (!(n > 0)) return '';
    var d = new Date(n);
    if (!isFinite(d.getTime())) return '';
    var mm = String(d.getMonth() + 1);
    var dd = String(d.getDate());
    if (mm.length < 2) mm = '0' + mm;
    if (dd.length < 2) dd = '0' + dd;
    return d.getFullYear() + '.' + mm + '.' + dd;
  }

  function previewBody(item) {
    if (item.summary) return item.summary;
    if (item.content) return item.content;
    if (item.oneLine) return item.oneLine;
    return '';
  }

  function syncPreview() {
    if (!dom.preview) return;
    var item = selectedItem();
    if (!item) {
      dom.preview.hidden = true;
      dom.ariaLive.textContent = '';
      return;
    }
    dom.preview.hidden = false;
    var meta = [];
    var date = formatDate(item.created);
    if (date) meta.push(date);
    if (item.domain) meta.push(item.domain);
    meta.push('重要性 ' + item.importance);
    if (item.pinned) meta.push('置顶');
    if (item.resolved) meta.push('已解决');
    dom.previewMeta.textContent = meta.join(' · ');
    dom.previewTitle.textContent = item.title || FALLBACK_TITLE;
    var body = previewBody(item);
    dom.previewBody.textContent = body || '这条记忆没有摘要。';
    dom.previewBody.hidden = !body;
    dom.ariaLive.textContent = '已选中：' + (item.title || FALLBACK_TITLE)
      + (date ? '，' + date : '') + (item.domain ? '，' + item.domain : '');
  }

  function selectById(id, options) {
    options = options || {};
    var next = id ? String(id) : null;
    if (next && !(state.byId && state.byId[next])) next = null;
    state.selectedId = next;
    if (options.focusFinder) {
      syncFinderSelection();
    }
    if (state.ready) {
      for (var i = 0; i < surfaces.length; i++) paintNodes(surfaces[i]);
    }
    syncPreview();
    return state.selectedId;
  }

  function stepSelection(delta) {
    if (!state.nodes.length) return null;
    var ids = state.nodes.map(function (n) { return n.id; });
    var at = state.selectedId ? ids.indexOf(state.selectedId) : -1;
    var next = at < 0 ? (delta > 0 ? 0 : ids.length - 1) : (at + delta + ids.length) % ids.length;
    return selectById(ids[next]);
  }

  /* ------------------------------------------------------------ 查找面板 */
  /* 可访问路径：canvas 不能逐节点可达，因此提供一个等价的键盘/读屏入口。
     它读的是同一份 state.items，不建立第二份 memory authority。 */

  var FINDER_LIMIT = 60;

  function finderMatches() {
    var q = state.finderQuery.trim().toLowerCase();
    if (!q) return state.items.slice();
    var out = [];
    for (var i = 0; i < state.items.length; i++) {
      var it = state.items[i];
      var hay = (it.title + ' ' + it.summary + ' ' + it.domain + ' ' + it.tags.join(' ')).toLowerCase();
      if (hay.indexOf(q) >= 0) out.push(it);
    }
    return out;
  }

  function renderFinder() {
    if (!dom.finderList) return;
    var matches = finderMatches();
    var shown = matches.slice(0, FINDER_LIMIT);
    dom.finderList.textContent = '';
    var frag = document.createDocumentFragment();
    for (var i = 0; i < shown.length; i++) {
      var it = shown[i];
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'memory-world__finder-row';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', it.id === state.selectedId ? 'true' : 'false');
      row.setAttribute('data-memory-id', it.id);
      row.textContent = it.title || FALLBACK_TITLE;
      frag.appendChild(row);
    }
    if (!matches.length) {
      var empty = document.createElement('div');
      empty.className = 'memory-world__finder-empty';
      empty.textContent = state.items.length ? '没有匹配的记忆。' : '这里还没有形成记忆。';
      frag.appendChild(empty);
    }
    dom.finderList.appendChild(frag);
    var note;
    if (!state.items.length) note = '共 0 条记忆';
    else if (matches.length > shown.length) {
      note = '匹配 ' + matches.length + ' 条 · 显示前 ' + shown.length + ' 条（其余在 Memory 列表里）';
    } else note = '匹配 ' + matches.length + ' 条 · 全部显示';
    dom.finderNote.textContent = note;
  }

  function syncFinderSelection() {
    if (!dom.finderList) return;
    var rows = dom.finderList.querySelectorAll('[data-memory-id]');
    for (var i = 0; i < rows.length; i++) {
      rows[i].setAttribute('aria-selected', rows[i].getAttribute('data-memory-id') === state.selectedId ? 'true' : 'false');
    }
  }

  function setFinderOpen(open) {
    state.finderOpen = !!open;
    if (!dom.finder) return;
    dom.finder.hidden = !state.finderOpen;
    if (dom.finderToggle) dom.finderToggle.setAttribute('aria-expanded', state.finderOpen ? 'true' : 'false');
    if (state.finderOpen) {
      renderFinder();
      if (dom.finderInput) dom.finderInput.focus({ preventScroll: true });
    }
  }

  /* ------------------------------------------------------------ DOM 构建 */

  function el(tag, className, parent) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }

  /* 入口 = WORLD WINDOW：页面里打开的一块空间切片。
     没有边框 / 圆角 / 阴影 —— 边缘由画布自己溶解（applyEdgeFade），
     标题也不占左下角标准 Hero 位。 */
  function buildEntry() {
    var entry = el('button', 'memory-world-scope memory-world-entry');
    entry.type = 'button';
    entry.id = 'mem-world-entry';
    entry.setAttribute('aria-haspopup', 'dialog');
    entry.setAttribute('aria-controls', 'mem-world-overlay');

    var frame = el('span', 'memory-world-entry__frame', entry);
    var env = el('canvas', 'memory-world-entry__env', frame);
    env.id = 'mem-world-entry-env';
    env.setAttribute('aria-hidden', 'true');
    var mist = el('canvas', 'memory-world-entry__mist', frame);
    mist.id = 'mem-world-entry-mist';
    mist.setAttribute('aria-hidden', 'true');
    var nodes = el('canvas', 'memory-world-entry__nodes', frame);
    nodes.id = 'mem-world-entry-nodes';
    nodes.setAttribute('aria-hidden', 'true');

    var caption = el('span', 'memory-world-entry__caption', frame);
    var title = el('span', 'memory-world-entry__title', caption);
    title.textContent = 'Memory World';
    var cn = el('span', 'memory-world-entry__cn', caption);
    cn.textContent = '记忆世界';
    var count = el('span', 'memory-world-entry__count', caption);
    count.textContent = '正在读取记忆…';
    var line = el('span', 'memory-world-entry__line', caption);
    line.textContent = '记忆不是一张列表，是一个可以下潜的地方。';

    var go = el('span', 'memory-world-entry__go', frame);
    go.textContent = '进入世界';

    entry.addEventListener('click', function () { openWorld(); });

    return { root: entry, env: env, mist: mist, nodes: nodes, count: count };
  }

  function buildWorld() {
    var root = el('div', 'memory-world-scope memory-world');
    root.id = 'mem-world-overlay';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Memory World 记忆世界');
    root.hidden = false;

    var bar = el('header', 'memory-world__bar', root);
    var idBox = el('div', 'memory-world__id', bar);
    var title = el('h2', 'memory-world__title', idBox);
    title.textContent = 'Memory World';
    var count = el('p', 'memory-world__count', idBox);
    count.textContent = '正在读取记忆…';
    var authority = el('p', 'memory-world__authority', idBox);
    authority.id = 'mem-world-authority';
    authority.dataset.state = 'checking';
    authority.setAttribute('role', 'status');
    authority.setAttribute('aria-live', 'polite');
    authority.textContent = '正在确认 Memory 来源…';

    var tools = el('div', 'memory-world__tools', bar);

    /* 次要动作收进 ··· 菜单：世界占满注意力，chrome 只有两个点。 */
    var menuWrap = el('div', 'memory-world__menu-wrap', tools);
    var menuToggle = el('button', 'memory-world__icon', menuWrap);
    menuToggle.type = 'button';
    menuToggle.id = 'mem-world-menu-toggle';
    menuToggle.textContent = '\u00b7\u00b7\u00b7';
    menuToggle.setAttribute('aria-label', '更多');
    menuToggle.setAttribute('aria-haspopup', 'true');
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-controls', 'mem-world-menu');

    var menuPanel = el('div', 'memory-world__menu', menuWrap);
    menuPanel.id = 'mem-world-menu';
    menuPanel.setAttribute('role', 'menu');
    menuPanel.setAttribute('aria-label', '世界设置');
    menuPanel.hidden = false;

    var finderToggle = el('button', 'memory-world__menu-item', menuPanel);
    finderToggle.type = 'button';
    finderToggle.id = 'mem-world-finder-toggle';
    finderToggle.textContent = '查找记忆';
    finderToggle.setAttribute('role', 'menuitem');
    finderToggle.setAttribute('aria-expanded', 'false');
    finderToggle.setAttribute('aria-controls', 'mem-world-finder');
    finderToggle.addEventListener('click', function () {
      setMenuOpen(false);
      setFinderOpen(!state.finderOpen);
    });

    var envToggle = el('button', 'memory-world__menu-item memory-world__btn--toggle', menuPanel);
    envToggle.type = 'button';
    envToggle.id = 'mem-world-motion-toggle';
    envToggle.textContent = '入口潮涌';
    envToggle.setAttribute('aria-checked', 'true');
    envToggle.setAttribute('role', 'menuitemcheckbox');
    envToggle.addEventListener('click', function () {
      setMotion(!state.motion);
    });

    var exit = el('button', 'memory-world__icon memory-world__icon--exit', tools);
    exit.type = 'button';
    exit.id = 'mem-world-exit';
    exit.textContent = '\u00d7';
    exit.setAttribute('aria-label', '退出 Memory World');
    exit.addEventListener('click', function () { closeWorld('exit'); });

    var stage = el('div', 'memory-world__stage', root);
    var envCanvas = el('canvas', 'memory-world__env', stage);
    envCanvas.id = 'mem-world-env';
    envCanvas.setAttribute('aria-hidden', 'true');
    var mistCanvas = el('canvas', 'memory-world__mist', stage);
    mistCanvas.id = 'mem-world-mist';
    mistCanvas.setAttribute('aria-hidden', 'true');
    var nodeCanvas = el('canvas', 'memory-world__nodes', stage);
    nodeCanvas.id = 'mem-world-nodes';
    nodeCanvas.setAttribute('aria-hidden', 'true');

    var quiet = el('div', 'memory-world__quiet', stage);
    quiet.id = 'mem-world-quiet';
    quiet.hidden = true;
    var quietTitle = el('p', 'memory-world__quiet-title', quiet);
    quietTitle.textContent = '这里还没有形成记忆。';
    var quietNote = el('p', 'memory-world__quiet-note', quiet);
    quietNote.textContent = '在 Memory 页写下第一条，世界就会亮起来。';

    /* preview = annotation（浮注），不是管理 card。 */
    var preview = el('aside', 'memory-world__preview', stage);
    preview.id = 'mem-world-preview';
    preview.hidden = true;
    preview.setAttribute('aria-label', '选中的记忆');
    var previewMeta = el('p', 'memory-world__preview-meta', preview);
    var previewTitle = el('h3', 'memory-world__preview-title', preview);
    var previewBody = el('p', 'memory-world__preview-body', preview);
    var previewFoot = el('div', 'memory-world__preview-foot', preview);
    var previewState = el('span', 'memory-world__preview-state', previewFoot);
    previewState.textContent = '点选世界里的光点';
    var openBtn = el('button', 'memory-world__open', previewFoot);
    openBtn.type = 'button';
    openBtn.id = 'mem-world-open';
    openBtn.textContent = '打开记忆';
    openBtn.addEventListener('click', openSelectedDetail);

    /* finder = command palette（窄、居中偏上、低 chrome）。 */
    var finder = el('div', 'memory-world__finder', stage);
    finder.id = 'mem-world-finder';
    finder.hidden = true;
    finder.setAttribute('role', 'dialog');
    finder.setAttribute('aria-label', '在记忆世界里查找');
    var field = el('div', 'memory-world__finder-field', finder);
    var input = document.createElement('input');
    input.type = 'search';
    input.className = 'memory-world__finder-input';
    input.id = 'mem-world-search';
    input.placeholder = '在记忆中查找…';
    input.setAttribute('aria-label', '在记忆中查找');
    input.setAttribute('autocomplete', 'off');
    field.appendChild(input);
    var note = el('p', 'memory-world__finder-note', finder);
    var list = el('div', 'memory-world__finder-list', finder);
    list.id = 'mem-world-finder-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', '记忆索引');

    var live = el('p', 'memory-world__sr', root);
    live.id = 'mem-world-live';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');

    input.addEventListener('input', function () {
      state.finderQuery = input.value;
      renderFinder();
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        var first = dom.finderList.querySelector('[data-memory-id]');
        if (first) first.focus();
      }
    });
    list.addEventListener('keydown', function (ev) {
      var rows = Array.prototype.slice.call(dom.finderList.querySelectorAll('[data-memory-id]'));
      var at = rows.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown' && at >= 0 && at < rows.length - 1) {
        ev.preventDefault();
        rows[at + 1].focus();
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (at > 0) rows[at - 1].focus();
        else if (dom.finderInput) dom.finderInput.focus();
      }
    });
    list.addEventListener('click', function (ev) {
      var row = ev.target && ev.target.closest ? ev.target.closest('[data-memory-id]') : null;
      if (row) selectById(row.getAttribute('data-memory-id'), { focusFinder: true });
    });
    list.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      var row = ev.target && ev.target.closest ? ev.target.closest('[data-memory-id]') : null;
      if (!row) return;
      ev.preventDefault();
      selectById(row.getAttribute('data-memory-id'), { focusFinder: true });
    });

    nodeCanvas.addEventListener('click', function (ev) {
      var hit = hitTest(nodeCanvas, ev);
      selectById(hit);
    });
    nodeCanvas.addEventListener('pointermove', function (ev) {
      var hit = hitTest(nodeCanvas, ev);
      if (hit !== state.hoverId) {
        state.hoverId = hit;
        nodeCanvas.style.cursor = hit ? 'pointer' : 'default';
        var surface = surfaceOf(nodeCanvas);
        if (surface) paintNodes(surface);
      }
    });
    nodeCanvas.addEventListener('pointerleave', function () {
      if (state.hoverId) {
        state.hoverId = null;
        nodeCanvas.style.cursor = 'default';
        var surface = surfaceOf(nodeCanvas);
        if (surface) paintNodes(surface);
      }
    });

    root.addEventListener('keydown', onWorldKeydown);

    menuToggle.addEventListener('click', function (ev) {
      ev.stopPropagation();
      setMenuOpen(!state.menuOpen);
    });
    root.addEventListener('click', function (ev) {
      if (!state.menuOpen) return;
      if (menuWrap.contains(ev.target)) return;
      setMenuOpen(false);
    });

    return {
      root: root,
      bar: bar,
      count: count,
      authority: authority,
      env: envCanvas,
      mist: mistCanvas,
      nodes: nodeCanvas,
      quiet: quiet,
      preview: preview,
      previewMeta: previewMeta,
      previewTitle: previewTitle,
      previewBody: previewBody,
      previewState: previewState,
      finder: finder,
      finderToggle: finderToggle,
      finderInput: input,
      finderList: list,
      finderNote: note,
      exit: exit,
      motionToggle: envToggle,
      menuToggle: menuToggle,
      menuWrap: menuWrap,
      ariaLive: live
    };
  }

  function surfaceOf(canvas) {
    for (var i = 0; i < surfaces.length; i++) {
      if (surfaces[i].nodes === canvas || surfaces[i].env === canvas || surfaces[i].mist === canvas) return surfaces[i];
    }
    return null;
  }

  function hitTest(canvas, ev) {
    var surface = surfaceOf(canvas);
    if (!surface || !surface.hit) return null;
    var box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    var x = (ev.clientX - box.left) * (surface.w / box.width);
    var y = (ev.clientY - box.top) * (surface.h / box.height);
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < surface.hit.length; i++) {
      var h = surface.hit[i];
      var dx = h.x - x;
      var dy = h.y - y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d <= h.r && d < bestD) {
        bestD = d;
        best = h.id;
      }
    }
    return best;
  }

  /* ------------------------------------------------------------- 键盘契约 */

  function onWorldKeydown(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (state.finderOpen) setFinderOpen(false);
      else if (state.menuOpen) setMenuOpen(false);
      else closeWorld('escape');
      return;
    }
    if (ev.key === 'Tab') {
      trapTab(ev);
      return;
    }
  }

  /* ··· 次要菜单：世界占满注意力，工具收起来。 */
  function setMenuOpen(open) {
    state.menuOpen = !!open;
    if (dom.menuToggle) dom.menuToggle.setAttribute('aria-expanded', state.menuOpen ? 'true' : 'false');
    if (dom.menuWrap) dom.menuWrap.setAttribute('data-open', state.menuOpen ? 'true' : 'false');
  }

  function focusableIn(root) {
    var nodes = root.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    return Array.prototype.filter.call(nodes, function (node) {
      return !node.hidden && node.offsetParent !== null;
    });
  }

  function trapTab(ev) {
    /* 既有 memory 编辑弹窗打开时，焦点归它管，不要抢。 */
    if (document.querySelector('.mem-modal-overlay.show')) return;
    var list = focusableIn(dom.root);
    if (!list.length) return;
    var first = list[0];
    var last = list[list.length - 1];
    var active = document.activeElement;
    if (!list.includes(active)) {
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus({ preventScroll: true });
    } else if (ev.shiftKey && active === first) {
      ev.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  function onDocumentKeydown(ev) {
    if (!state.open) return;
    if (ev.key === 'Escape' && !dom.root.contains(ev.target)) {
      ev.preventDefault();
      closeWorld('escape');
    }
  }

  /* ---------------------------------------------------------------- 开关 */

  function openWorld() {
    if (state.open) return;
    state.open = true;
    setMenuOpen(false);
    var active = document.activeElement;
    /* 焦点从哪里来回哪里去；没有可用的触发元素时退回入口本身
       （程序化点击不会移动焦点，真实指针点击会）。 */
    state.returnFocus = (!active || active === document.body || dom.root.contains(active))
      ? dom.entry
      : active;
    dom.root.classList.add('is-open');
    pushHistory();
    if (!state.ready && !state.loading) {
      reload().then(function () { /* 打开后再补齐数据 */ });
    } else {
      paintAll();
    }
    if (dom.exit && dom.exit.focus) dom.exit.focus({ preventScroll: true });
  }

  function closeWorld(reason) {
    if (!state.open) return;
    state.open = false;
    dom.root.classList.remove('is-open');
    state.hoverId = null;
    setFinderOpen(false);
    setMenuOpen(false);
    if (state.historyPushed && reason !== 'history') {
      state.historyPushed = false;
      try { history.back(); } catch (e) { /* 退不了就只关视图 */ }
    } else {
      state.historyPushed = false;
    }
    var back = state.returnFocus;
    state.returnFocus = null;
    if (back && back.isConnected && typeof back.focus === 'function') {
      try { back.focus({ preventScroll: true }); } catch (e) { /* noop */ }
    }
  }

  function pushHistory() {
    state.historyPushed = false;
    try {
      history.pushState({ ibMemoryWorld: true }, '', location.href);
      state.historyPushed = true;
    } catch (e) {
      /* file:// 或受限环境下不支持：退化为只用 Esc / 退出按钮。 */
      state.historyPushed = false;
    }
  }

  function openSelectedDetail() {
    var item = selectedItem();
    if (!item) return;
    /* 「打开记忆」交回既有 detail/edit authority，本模块不复制编辑器。 */
    if (typeof window.openMemoryModal === 'function') {
      window.openMemoryModal(item.id);
    }
  }

  function setMotion(on) {
    state.motion = !!on;
    var value = state.motion ? 'on' : 'off';
    if (dom.root) dom.root.setAttribute('data-motion', value);
    if (dom.entry) dom.entry.setAttribute('data-motion', value);
    if (dom.motionToggle) dom.motionToggle.setAttribute('aria-checked', state.motion ? 'true' : 'false');
  }

  /* ------------------------------------------------------------- 生命周期 */

  function applyReducedMotion() {
    var reduce = !!(reduceQuery && reduceQuery.matches);
    setMotion(!reduce);
    if (dom.root) dom.root.setAttribute('data-reduced-motion', reduce ? 'true' : 'false');
  }

  function bindEnvironmentObservers() {
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { scheduleResize(); });
      for (var i = 0; i < surfaces.length; i++) {
        if (surfaces[i].env) ro.observe(surfaces[i].env);
        if (surfaces[i].mist) ro.observe(surfaces[i].mist);
        if (surfaces[i].nodes) ro.observe(surfaces[i].nodes);
      }
    }
    document.addEventListener('visibilitychange', function () {
      var paused = document.hidden ? 'true' : 'false';
      if (dom.root) dom.root.setAttribute('data-paused', paused);
      if (dom.entry) dom.entry.setAttribute('data-paused', paused);
    });
    if (reduceQuery) {
      if (typeof reduceQuery.addEventListener === 'function') {
        reduceQuery.addEventListener('change', applyReducedMotion);
      } else if (typeof reduceQuery.addListener === 'function') {
        reduceQuery.addListener(applyReducedMotion);
      }
    }
  }

  var resizeScheduled = false;
  function scheduleResize() {
    if (resizeScheduled) return;
    resizeScheduled = true;
    var run = function () {
      resizeScheduled = false;
      if (!state.ready) return;
      paintAll();
    };
    if (window.requestAnimationFrame) requestAnimationFrame(run);
    else setTimeout(run, 60);
  }

  function updateCounts() {
    var n = state.items.length;
    var label = n + ' 条记忆';
    if (dom.entryCount) dom.entryCount.textContent = label;
    if (dom.worldCount) dom.worldCount.textContent = label;
    if (dom.worldAuthority) {
      var helper = window.getMemoryAuthorityUiState;
      var info = typeof helper === 'function'
        ? helper(null, state.lastError ? new Error(state.lastError) : null)
        : { state: 'unavailable', label: 'AUTHORITY UNKNOWN', detail: '无法确认 Memory 数据来源。' };
      dom.worldAuthority.dataset.state = info.state || 'unavailable';
      dom.worldAuthority.textContent = info.label + ' · ' + info.detail;
      dom.worldAuthority.title = info.detail || '';
    }
    if (dom.quiet) dom.quiet.hidden = n > 0;
    if (dom.entry) dom.entry.setAttribute('aria-label', '进入 Memory World 记忆世界，共 ' + n + ' 条记忆');
  }

  function reload() {
    if (state.loading) return state.loading;
    state.loading = readMemories().then(function (items) {
      state.items = items;
      for (var vi = 0; vi < items.length; vi++) items[vi].visualWeight = visualScore(items[vi]);
      assignTiers(items);                 /* 70 / 20 / 8 / 2 视觉分层（按排名分位） */
      state.tierCounts = { anchor: 0, strong: 0, light: 0, speck: 0 };
      for (var ti = 0; ti < items.length; ti++) state.tierCounts[items[ti].tier] += 1;
      indexById();
      state.nodes = computeLayout(items);
      state.fingerprint = layoutFingerprint(state.nodes, items);
      state.ready = true;
      state.loading = false;
      state.lastError = null;
      updateCounts();
      if (state.selectedId && !state.byId[state.selectedId]) state.selectedId = null;
      syncPreview();
      if (state.finderOpen) renderFinder();
      palette = buildPalette();
      paintAll();
      return state.items;
    }, function (error) {
      state.loading = false;
      state.ready = true;
      state.lastError = String(error && error.message ? error.message : error);
      state.items = [];
      state.nodes = [];
      state.fingerprint = layoutFingerprint([], []);
      updateCounts();
      palette = buildPalette();
      paintAll();
      return [];
    });
    return state.loading;
  }

  function onPageActive() {
    if (!state.mounted) return;
    if (!state.ready && !state.loading) reload();
    else scheduleResize();
    state.entered = true;
  }

  function watchPage() {
    var page = document.getElementById('page-memory');
    if (!page) return;
    var sync = function () {
      if (page.classList.contains('active')) onPageActive();
    };
    if (window.MutationObserver) {
      new MutationObserver(sync).observe(page, { attributes: true, attributeFilter: ['class'] });
    }
    var onHash = function () {
      if (state.open && String(location.hash || '') !== '#memory') closeWorld('navigation');
      sync();
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', function () {
      if (state.open && state.historyPushed) closeWorld('history');
    });
    sync();
  }

  function watchTheme() {
    if (!window.MutationObserver || !document.body) return;
    var pending = false;
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      var run = function () { pending = false; invalidate(); };
      if (window.requestAnimationFrame) requestAnimationFrame(run);
      else setTimeout(run, 50);
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  function injectStyles() {
    if (document.getElementById(CSS_ID)) return;
    var link = document.createElement('link');
    link.id = CSS_ID;
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    document.head.appendChild(link);
  }

  function ensureProbe() {
    if (probe) return;
    probe = document.createElement('span');
    probe.className = 'memory-world__sr';
    probe.setAttribute('aria-hidden', 'true');
    probe.id = 'mem-world-probe';
  }

  /* --------------------------------------- 旧星图共存（DOM 重排，非删除） */
  /* STAR_MAP_COEXISTENCE_DECISION = C+B：把既有星图迁入 Library 段并默认折叠。
     理由（见审计）：星图是 ambient 数据视图，**没有交互**（点星只冒一下火花，
     不导航、不打开记忆），却紧贴在 Memory World 入口下方，形成两个互相竞争的
     视觉场。它一个功能都不删：同样的 id、同样的 buildMemorySky、
     同样的 legend，只是从「页面主角位」移到 Library 末尾的一个折叠项，
     展开即用（canvas 由 ResizeObserver 在尺寸出现时重建）。 */
  function foldStarMap() {
    var page = document.getElementById('page-memory');
    if (!page) return false;
    var sky = document.getElementById('mem-sky');
    var layout = page.querySelector('.mem-page-layout');
    if (!sky || !layout) return false;
    if (document.getElementById('mem-world-skyfold')) return true;

    var fold = document.createElement('details');
    fold.className = 'memory-world-scope memory-world-skyfold';
    fold.id = 'mem-world-skyfold';
    var summary = document.createElement('summary');
    summary.className = 'memory-world-skyfold__summary';
    var label = document.createElement('span');
    label.textContent = '星图 · Star Map';
    var hint = document.createElement('span');
    hint.className = 'memory-world-skyfold__hint';
    hint.textContent = '效价 / 唤醒散点 · 原 Memory Observatory';
    summary.appendChild(label);
    summary.appendChild(hint);
    var body = document.createElement('div');
    body.className = 'memory-world-skyfold__body';
    fold.appendChild(summary);
    fold.appendChild(body);

    var legend = document.getElementById('mem-sky-legend');
    body.appendChild(sky);
    if (legend) body.appendChild(legend);
    layout.parentNode.insertBefore(fold, layout.nextSibling);
    return true;
  }

  function mount() {
    if (state.mounted) return api;
    if (!document.body) return api;
    injectStyles();
    ensureProbe();
    document.body.appendChild(probe);

    var page = document.getElementById('page-memory');
    if (!page) return api;

    var entry = buildEntry();
    var intro = page.querySelector('.module-intro');
    if (intro && intro.parentNode === page) page.insertBefore(entry.root, intro.nextSibling);
    else page.insertBefore(entry.root, page.firstChild);

    var world = buildWorld();
    document.body.appendChild(world.root);

    dom.entry = entry.root;
    dom.entryEnv = entry.env;
    dom.entryMist = entry.mist;
    dom.entryNodes = entry.nodes;
    dom.entryCount = entry.count;
    dom.root = world.root;
    dom.worldCount = world.count;
    dom.worldAuthority = world.authority;
    dom.worldEnv = world.env;
    dom.worldMist = world.mist;
    dom.worldNodes = world.nodes;
    dom.quiet = world.quiet;
    dom.preview = world.preview;
    dom.previewMeta = world.previewMeta;
    dom.previewTitle = world.previewTitle;
    dom.previewBody = world.previewBody;
    dom.previewState = world.previewState;
    dom.finder = world.finder;
    dom.finderToggle = world.finderToggle;
    dom.finderInput = world.finderInput;
    dom.finderList = world.finderList;
    dom.finderNote = world.finderNote;
    dom.exit = world.exit;
    dom.motionToggle = world.motionToggle;
    dom.menuToggle = world.menuToggle;
    dom.menuWrap = world.menuWrap;
    dom.ariaLive = world.ariaLive;

    surfaces = [
      { key: 'entry', entry: true, env: entry.env, mist: entry.mist, nodes: entry.nodes, host: entry.root },
      { key: 'world', entry: false, env: world.env, mist: world.mist, nodes: world.nodes, host: world.root }
    ];

    foldStarMap();

    reduceQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    applyReducedMotion();

    document.addEventListener('keydown', onDocumentKeydown);
    bindEnvironmentObservers();
    watchTheme();

    /* mounted 必须在 watchPage() 之前置位：若用户已经停在 Memory 页，
       watchPage 的首次同步会立即触发 onPageActive()。 */
    state.mounted = true;
    watchPage();

    palette = buildPalette();
    paintAll();
    updateCounts();
    return api;
  }

  /* ------------------------------------------------------------------ API */

  var api = {
    version: VERSION,
    role: 'PRESENTATION_LAYER_ONLY',
    dataAuthority: "window.dbGetAll('memories')",
    associationLines: 'DISABLED',
    positionSemanticAuthority: 'NO',
    cognitivePrivateStateExposure: 'NONE',
    worldSeed: WORLD_SEED,
    macroBands: RIFT_BANDS.length,
    bandGeometry: function () {
      return RIFT_BANDS.map(function (b) {
        return { key: b.key, base: b.base, thickness: b.thickness, breaks: b.breaks.slice() };
      });
    },
    setMenuOpen: setMenuOpen,
    mounted: false,
    mount: mount,
    open: openWorld,
    close: closeWorld,
    isOpen: function () { return state.open; },
    reload: reload,
    select: selectById,
    step: stepSelection,
    selected: function () { return state.selectedId; },
    items: function () { return state.items.length; },
    layout: function () {
      return state.nodes.map(function (n) { return { id: n.id, x: n.x, y: n.y }; });
    },
    layoutFingerprint: function () { return state.fingerprint; },
    setMotion: setMotion,
    setEnvironment: function (on) {
      state.envOn = !!on;
      paintAll();
    },
    setFinderOpen: setFinderOpen,
    stats: function () {
      var out = {
        items: state.items.length,
        renderedNodes: state.renderedNodes,
        renderMs: Math.round(state.renderMs * 1000) / 1000,
        fingerprint: state.fingerprint,
        mounted: state.mounted,
        ready: state.ready,
        error: state.lastError,
        domNodes: dom.root ? dom.root.querySelectorAll('*').length : 0,
        surfaces: []
      };
      for (var i = 0; i < surfaces.length; i++) {
        out.surfaces.push({
          key: surfaces[i].key,
          w: surfaces[i].w || 0,
          h: surfaces[i].h || 0,
          envW: surfaces[i].envW || 0,
          envH: surfaces[i].envH || 0,
          mistW: surfaces[i].mistW || 0,
          mistH: surfaces[i].mistH || 0,
          dpr: surfaces[i].dpr || 1,
          painted: !!surfaces[i].painted
        });
      }
      out.tierCounts = state.tierCounts || { anchor: 0, strong: 0, light: 0, speck: 0 };
      out.macroBands = RIFT_BANDS.length;
      out.worldSeed = WORLD_SEED;
      out.menuOpen = !!state.menuOpen;
      out.finderOpen = !!state.finderOpen;
      return out;
    },
    _internals: {
      hash32: hash32,
      unit: unit,
      computeLayout: computeLayout,
      layoutFingerprint: layoutFingerprint,
      FITTER: 'canvas2d'
    }
  };

  api.mounted = true;
  NS.expose('memoryWorld', api);

  /* 模块注册（api.mounted）与挂载完成（state.mounted）是两件事：
     脚本可能在解析途中执行，此时要等 DOMContentLoaded 才有完整 DOM。
     如果在这里就把 state.mounted 置位，被延迟的 mount() 会被自己的
     幂等守卫挡掉 —— 那正是 UI-P1 首轮实跑暴露的竞态。 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { mount(); }, { once: true });
  } else {
    mount();
  }
})(window.IB || (window.IB = {}));
