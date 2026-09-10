/* ====================================================================
   P14 · Middle Brain 整块折叠 · 专项测试（静态、零依赖、无浏览器）
   --------------------------------------------------------------------
   目的：验证「API 页面整个 Middle Brain 配置区折叠」这一改动的行为契约，
        且**不重新实现生产逻辑**：
        - 生产层 assets/js/middle-brain-config.js 原样加载进沙箱；
        - 唯一被替换的边界是 IndexedDB 读写（dbGet/dbPut）与 document
          （极简 DOM stub，只实现本层真正用到的 API）。
   覆盖（对应交付要求 10）：
      A. HTML / CSS 结构：折叠头 + body wrapper（整个区块，不是只折叠子卡片）
      B. 初始 collapsed 状态：默认收起 / 首次配置或配置不完整默认展开
      C. 点击展开 → 再次点击收起；aria-expanded 同步
      D. 键盘 Enter / Space 切换（button 原生语义）
      E. 展开前后 model / reasoning / processing / image mode 状态不变
      F. API Key input value 不丢（DOM 不销毁）
      G. 刷新（重新 loadMiddleBrainConfigUI）后 collapsed 状态恢复
      H. summary 动态生成：model · reasoning · processing · image mode
      I. 不重复绑定 listener / 不重新初始化 Middle Brain
      J. 页面无异常（层加载、重复 load、切换过程零 throw）
   运行：node test_middle_brain_collapse.js
   ==================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};
const readUtf8 = rel => fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/^\uFEFF/, '');
/* loadMiddleBrainConfigUI 是 async（内部 promise 链）：等它落定再断言 */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/* ── 极简 DOM stub（只实现 middle-brain-config.js 真正用到的 API） ── */
function createDom() {
  const byId = new Map();
  const listeners = new Map();      /* id -> { type: count } */

  function queryAll(sel) {
    const out = [];
    for (const el of byId.values()) {
      if (sel[0] === '#') { if (el.id === sel.slice(1)) out.push(el); }
      else if (sel[0] === '.') { if (el.classList.contains(sel.slice(1))) out.push(el); }
    }
    return out;
  }
  function mkEl(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(), id: '', type: '', className: '', textContent: '',
      value: '', checked: false, disabled: false, placeholder: '', title: '', style: {},
      children: [], parentNode: null, _attrs: {}, _handlers: {},
      get dataset() {
        const a = this._attrs;
        return new Proxy({}, {
          get: (_, k) => a['data-' + String(k)],
          set: (_, k, v) => { a['data-' + String(k)] = String(v); return true; }
        });
      },
      get classList() {
        const self = this;
        return {
          add(c) { if (!self._cls().includes(c)) self._attrs.class = self._cls().concat(c).join(' '); },
          remove(c) { self._attrs.class = self._cls().filter(x => x !== c).join(' '); },
          contains(c) { return self._cls().includes(c); },
          toggle(c, force) { const on = force === undefined ? !this.contains(c) : !!force; if (on) this.add(c); else this.remove(c); return on; }
        };
      },
      _cls() { return String(this._attrs.class || '').split(/\s+/).filter(Boolean); },
      setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') { this.id = String(v); byId.set(this.id, this); } },
      getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
      removeAttribute(k) { delete this._attrs[k]; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      addEventListener(type, fn) {
        const key = this.id || ('#' + this.tagName.toLowerCase() + '#' + byId.size);
        if (!listeners.has(key)) listeners.set(key, {});
        const rec = listeners.get(key);
        rec[type] = (rec[type] || 0) + 1;
        (this._handlers[type] = this._handlers[type] || []).push(fn);
      },
      /* 只用于测试触发：真实浏览器里 click() 会派发 click 事件 */
      click() { return this.dispatchEvent({ type: 'click' }); },
      dispatchEvent(ev) {
        for (const fn of (this._handlers[ev.type] || []).slice()) fn.call(this, ev);
        return true;
      },
      focus() { this._focused = true; },
      blur() { this._focused = false; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
      setPointerCapture() {},
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); }
    };
    Object.defineProperty(el, 'innerHTML', { get() { return ''; }, set(_v) { this.children = []; } });
    return el;
  }

  const doc = {
    readyState: 'complete',
    addEventListener() {},
    createElement(tag) { return mkEl(tag); },
    getElementById(id) { return byId.get(id) || null; },
    querySelector(sel) { return queryAll(sel)[0] || null; },
    querySelectorAll(sel) { return queryAll(sel); }
  };

  /* Middle Brain 卡片里被 JS 读取/写入的元素（id 与生产 HTML 一致） */
  const ids = [
    'mb-collapse-toggle', 'mb-collapse-summary', 'mb-collapse-badge', 'mb-collapse-chev', 'mb-collapse-body',
    'mb-enabled-toggle', 'mb-endpoint', 'mb-model', 'mb-apikey',
    'mb-adv-summary', 'mb-adv-model', 'mb-adv-reasoning', 'mb-adv-speed', 'mb-adv-image', 'mb-adv-image-hint',
    'mb-image-summary', 'mb-ci-summary', 'mb-ci-enabled', 'mb-ci-rewrite', 'mb-ci-verify', 'mb-ci-sensitivity',
    'mb-save-status'
  ];
  for (const id of ids) {
    /* 标签与生产 HTML 一致：折叠头是 <button>（键盘 Enter/Space 依赖原生语义），启用开关是 <input> */
    const tag = id === 'mb-collapse-toggle' ? 'button' : (id === 'mb-enabled-toggle' ? 'input' : 'div');
    const el = mkEl(tag);
    el.setAttribute('id', id);
  }
  /* 与生产 HTML 的初始态一致：默认收起 */
  byId.get('mb-collapse-toggle').setAttribute('aria-expanded', 'false');
  byId.get('mb-collapse-body').classList.add('is-collapsed');

  return { doc, byId, listeners, mkEl };
}

/* ── 生产层沙箱：只替换 IndexedDB 与 document ── */
function loadSandbox(opts) {
  opts = opts || {};
  const store = { apiSettings: {} };
  if (opts.mbConfig !== undefined) store.apiSettings.middle_brain = JSON.parse(JSON.stringify(opts.mbConfig));
  if (opts.uiPref !== undefined) store.apiSettings.middle_brain_ui = JSON.parse(JSON.stringify(opts.uiPref));
  const dbWrites = [];
  const dom = createDom();
  const providerDir = require(path.join(__dirname, 'assets', 'js', 'provider-directory.js'));
  const body = readUtf8('assets/js/middle-brain-config.js') + '\n;return self.IB.__middleBrainContracts;';
  const factory = new Function('self', 'module', 'document', 'dbGet', 'dbPut', 'require', body);
  const self = { PROVIDERS_DIR: providerDir };
  const MBC = factory(
    self, undefined, dom.doc,
    async (s, k) => (s === 'apiSettings' ? store.apiSettings[k] : undefined),
    async (s, d) => {
      dbWrites.push({ store: s, id: d && d.id });
      if (s === 'apiSettings' && d && d.id) store.apiSettings[d.id] = JSON.parse(JSON.stringify(d));
    },
    require
  );
  return { MBC, store, dbWrites, dom };
}

const CFG_INCOMPLETE = { enabled: false, endpoint: '', model: 'gpt-6-astra', apiKey: '' };
const CFG_COMPLETE = {
  enabled: true, endpoint: 'https://mb.example.com/v1/responses', model: 'gpt-5.6-sol', apiKey: 'sk-collapse',
  reasoningEffort: 'high', speed: 'fast', imageMode: 'precision'
};
const CFG_ENABLED_BUT_UNFINISHED = { enabled: true, endpoint: '', model: 'gpt-6-astra', apiKey: '' };

const bodyEl = sbx => sbx.dom.byId.get('mb-collapse-body');
const isCollapsed = sbx => bodyEl(sbx).classList.contains('is-collapsed');
const ariaExpanded = sbx => sbx.dom.byId.get('mb-collapse-toggle').getAttribute('aria-expanded');
const summary = sbx => sbx.dom.byId.get('mb-collapse-summary').textContent;
const badge = sbx => sbx.dom.byId.get('mb-collapse-badge').textContent;
const clickToggle = sbx => sbx.dom.byId.get('mb-collapse-toggle').click();
/* 键盘：<button> 原生把 Enter / Space 转成 click —— 断言原生语义成立（绑定确实挂在 button 上） */
const keyToggle = (sbx, key) => {
  const btn = sbx.dom.byId.get('mb-collapse-toggle');
  if (btn.tagName !== 'BUTTON') return false;
  if (key === 'Enter' || key === ' ' || key === 'Spacebar') { btn.click(); return true; }
  return false;
};
async function booted(opts) {
  const sbx = loadSandbox(opts);
  await sbx.MBC.config.loadMiddleBrainConfigUI();   /* 返回 Promise：折叠态初始化在同一链上 */
  return sbx;
}

(async function main() {
  console.log('P14 · Middle Brain collapse（整块折叠）· 专项静态测试\n');

  /* ═══════════════ A. HTML / CSS 结构 ═══════════════ */
  const html = readUtf8('InternalBeyond.html');
  const secStart = html.indexOf('id="middle-brain-section"');
  const sec = html.slice(secStart, html.indexOf('id="api-mgmt-title"', secStart));
  check('A1.headerButton', /<button[^>]*id="mb-collapse-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="mb-collapse-body"/.test(sec),
    '缺少折叠头 button 或 aria 属性');
  check('A2.bodyWrapper', /<div class="mb-collapse-body" id="mb-collapse-body">/.test(sec), '缺少 body wrapper');
  check('A3.collapsesWholeSection', (() => {
    const start = sec.indexOf('<div class="mb-collapse-body" id="mb-collapse-body">');
    const end = sec.indexOf('id="mb-save-status"');
    if (start < 0 || end < 0 || end < start) return false;
    const inner = sec.slice(start, end);
    /* 整块折叠 = 说明 / 启用 / Endpoint / API Key / Astra / Model / Reasoning / Processing / Image / CI 全在 body 内 */
    return ['mb-desc', 'mb-enabled-toggle', 'mb-endpoint', 'mb-apikey', 'mb-adv-model', 'mb-adv-reasoning',
      'mb-adv-speed', 'mb-adv-image', 'mb-image-summary', 'mb-ci-summary'].every(id => inner.indexOf(id) >= 0);
  })(), 'body 内未覆盖全部 Middle Brain 控件（可能只折叠了子卡片）');
  check('A4.noStyleBlocks', !/<style\b/i.test(html), 'HTML 出现内联 style 块');
  const css = readUtf8('assets/css/core.css');
  check('A5.cssTransition', /\.mb-collapse-body\{[^}]*transition:max-height/.test(css)
    && /\.mb-collapse-body\.is-collapsed\{[^}]*max-height:0/.test(css)
    && !/\.mb-collapse-body\.is-collapsed\{[^}]*display:none/.test(css),
    '折叠动画未使用 height/opacity 过渡，或用了 display:none');
  check('A6.cssReducedMotion', /@media \(prefers-reduced-motion:reduce\)/.test(css), '缺少 prefers-reduced-motion 处理');
  check('A7.cssResponsive', /@media \(max-width:560px\)\{\.mb-collapse-head/.test(css), '窄屏未处理摘要换行');

  /* ═══════════════ B. 初始 collapsed 状态 ═══════════════ */
  const s1 = await booted({ mbConfig: CFG_COMPLETE });
  check('B1.defaultCollapsedForConfiguredUser', isCollapsed(s1) === true && ariaExpanded(s1) === 'false',
    'collapsed=' + isCollapsed(s1) + ' aria=' + ariaExpanded(s1));

  const s2 = await booted({});
  check('B2.defaultExpandedForFirstRun', isCollapsed(s2) === false && ariaExpanded(s2) === 'true',
    'collapsed=' + isCollapsed(s2) + ' aria=' + ariaExpanded(s2));

  const s3 = await booted({ mbConfig: CFG_INCOMPLETE });
  check('B3.defaultExpandedForIncomplete', isCollapsed(s3) === false, '配置不完整时应展开');

  const s4 = await booted({ mbConfig: CFG_ENABLED_BUT_UNFINISHED });
  check('B4.enabledButUnfinishedExpanded', isCollapsed(s4) === false, 'enabled=true 且配置不完整时应展开（不因 enabled 强制展开）');

  const s5 = await booted({ mbConfig: CFG_INCOMPLETE, uiPref: { collapsed: true } });
  check('B5.explicitPrefWins', isCollapsed(s5) === true, '已保存偏好未被尊重');

  /* ═══════════════ C. 点击展开 / 收起 + aria ═══════════════ */
  const s6 = await booted({ mbConfig: CFG_COMPLETE });
  const initCollapsed = isCollapsed(s6);
  clickToggle(s6);
  const afterOpen = { collapsed: isCollapsed(s6), aria: ariaExpanded(s6) };
  clickToggle(s6);
  const afterClose = { collapsed: isCollapsed(s6), aria: ariaExpanded(s6) };
  check('C1.clickExpands', initCollapsed === true && afterOpen.collapsed === false && afterOpen.aria === 'true',
    JSON.stringify(afterOpen));
  check('C2.clickCollapsesAgain', afterClose.collapsed === true && afterClose.aria === 'false',
    JSON.stringify(afterClose));

  /* ═══════════════ D. 键盘 Enter / Space ═══════════════ */
  const s7 = await booted({ mbConfig: CFG_COMPLETE });
  const beforeKey = isCollapsed(s7);
  const enterOk = keyToggle(s7, 'Enter');
  const afterEnter = isCollapsed(s7);
  const spaceOk = keyToggle(s7, ' ');
  const afterSpace = isCollapsed(s7);
  check('D1.keyboardEnterSpaceToggle', enterOk && spaceOk && afterEnter === !beforeKey && afterSpace === beforeKey,
    'enter=' + afterEnter + ' space=' + afterSpace);

  /* ═══════════════ E/F. 展开前后状态不变 + API Key 不丢 ═══════════════ */
  const s8 = await booted({ mbConfig: CFG_COMPLETE });
  const ticksBefore = s8.dom.byId.get('mb-adv-reasoning').children.length;
  const apiKeyBefore = s8.dom.byId.get('mb-apikey').value;
  const modelBefore = s8.dom.byId.get('mb-model').value;
  const advSummaryBefore = s8.dom.byId.get('mb-adv-summary').textContent;
  clickToggle(s8); clickToggle(s8); clickToggle(s8);   /* 展开 → 收起 → 再展开 */
  const cfgAfter = await s8.MBC.config.getMiddleBrainConfig();
  check('E1.domNotDestroyed', ticksBefore > 0 && s8.dom.byId.get('mb-adv-reasoning').children.length === ticksBefore,
    'slider DOM 被重建/销毁');
  check('E2.stateUnchanged', cfgAfter.model === 'gpt-5.6-sol' && cfgAfter.reasoningEffort === 'high'
    && cfgAfter.speed === 'fast' && cfgAfter.imageMode === 'precision'
    && s8.dom.byId.get('mb-adv-summary').textContent === advSummaryBefore
    && s8.dom.byId.get('mb-image-summary').textContent === 'Precision',
    JSON.stringify({ model: cfgAfter.model, re: cfgAfter.reasoningEffort, sp: cfgAfter.speed, img: cfgAfter.imageMode }));
  check('E3.modelHiddenInputStable', modelBefore === 'gpt-5.6-sol' && s8.dom.byId.get('mb-model').value === modelBefore,
    '隐藏 model input 值变化');
  check('F1.apiKeyValueKept', apiKeyBefore === 'sk-collapse' && s8.dom.byId.get('mb-apikey').value === apiKeyBefore,
    JSON.stringify(apiKeyBefore) + ' -> ' + JSON.stringify(s8.dom.byId.get('mb-apikey').value));
  s8.MBC.config.saveMiddleBrainConfigUI();
  await settle();
  check('F2.apiKeyPersistsOnSave', s8.store.apiSettings.middle_brain.apiKey === 'sk-collapse', '保存后 API Key 丢失');

  /* ═══════════════ G. 刷新后 collapsed 恢复 ═══════════════ */
  const s9 = await booted({ mbConfig: CFG_COMPLETE });
  clickToggle(s9);                    /* 展开（用户显式选择） */
  await settle();
  const persisted = s9.store.apiSettings.middle_brain_ui;
  await s9.MBC.config.loadMiddleBrainConfigUI();   /* 模拟刷新 */
  check('G1.persistedInApiSettings', !!persisted && persisted.collapsed === false
    && s9.dbWrites.some(w => w.id === 'middle_brain_ui'), JSON.stringify(persisted));
  check('G2.stateRestoredAfterReload', isCollapsed(s9) === false && ariaExpanded(s9) === 'true',
    'collapsed=' + isCollapsed(s9));
  check('G3.uiKeySeparateFromConfig', s9.store.apiSettings.middle_brain.collapsed === undefined
    && s9.store.apiSettings.middle_brain.enabled === true, '折叠态污染了 canonical middle_brain 配置');
  clickToggle(s9);
  await settle();
  await s9.MBC.config.loadMiddleBrainConfigUI();
  check('G4.collapsedRestoredAfterReload', isCollapsed(s9) === true && ariaExpanded(s9) === 'false',
    'collapsed=' + isCollapsed(s9));

  /* ═══════════════ H. summary 动态生成 ═══════════════ */
  const s10 = await booted({ mbConfig: CFG_COMPLETE });
  const sum0 = summary(s10);
  check('H1.summaryFields', sum0 === 'gpt-5.6-sol · High · Fast · Precision', sum0);
  s10.MBC.config.mbReasoningPick('low');
  const sum1 = summary(s10);
  s10.MBC.config.mbSpeedPick('standard');
  const sum2 = summary(s10);
  s10.MBC.config.mbModelStep(-1);   /* 当前 gpt-5.6-sol 已在候选列表末尾，向后步进会夹住 */
  const sum3 = summary(s10);
  check('H2.summaryReasoningDynamic', /· Low ·/.test(sum1) && sum1 !== sum0, sum1);
  check('H3.summarySpeedDynamic', /· Standard ·/.test(sum2), sum2);
  check('H4.summaryModelDynamic', sum3.indexOf('gpt-6-astra') === 0, sum3);
  check('H5.summaryImageDynamic', /· Precision$/.test(sum0) && s10.dom.byId.get('mb-image-summary').textContent === 'Precision',
    sum0 + ' / ' + s10.dom.byId.get('mb-image-summary').textContent);
  const badgeOn = badge(s10) === 'Enabled';
  const en = s10.dom.byId.get('mb-enabled-toggle');
  en.checked = false; en.dispatchEvent({ type: 'change' });
  const badgeOff = badge(s10) === 'Disabled';
  en.checked = true; en.dispatchEvent({ type: 'change' });
  check('H6.badgeEnabledDisabled', badgeOn && badgeOff && badge(s10) === 'Enabled', badge(s10));

  /* ═══════════════ I. 不重复绑定 / 不重复初始化 ═══════════════ */
  const s11 = await booted({ mbConfig: CFG_COMPLETE });
  const l1 = s11.dom.listeners.get('mb-collapse-toggle').click;
  const cellsBefore = s11.dom.byId.get('mb-adv-model').children.length;
  await s11.MBC.config.loadMiddleBrainConfigUI();
  await s11.MBC.config.loadMiddleBrainConfigUI();
  const l2 = s11.dom.listeners.get('mb-collapse-toggle').click;
  clickToggle(s11); clickToggle(s11); clickToggle(s11);
  check('I1.listenerBoundOnce', l1 === 1 && l2 === 1, 'click listener 次数 ' + l1 + ' -> ' + l2);
  check('I2.noRebuildOnToggle', s11.dom.byId.get('mb-adv-model').children.length === cellsBefore,
    '切换折叠重建了 Middle Brain DOM');
  check('I3.enabledListenerOnce', s11.dom.listeners.get('mb-enabled-toggle').change === 1,
    String(s11.dom.listeners.get('mb-enabled-toggle').change));

  /* ═══════════════ J. 页面无异常 ═══════════════ */
  let threw = null;
  const s12 = loadSandbox({ mbConfig: CFG_COMPLETE });
  try {
    await s12.MBC.config.loadMiddleBrainConfigUI();
    clickToggle(s12); clickToggle(s12);
    s12.MBC.config.mbReasoningPick('high'); s12.MBC.config.mbSpeedPick('fast');
    s12.MBC.config.mbModelPick('gpt-5.6-sol'); s12.MBC.config.mbModelStep(-1);
    s12.MBC.config.saveMiddleBrainConfigUI();
    await settle();
    await s12.MBC.config.loadMiddleBrainConfigUI();
  } catch (e) { threw = e; }
  check('J1.noExceptions', threw === null, threw && (threw.stack || String(threw)));
  check('J2.publicContractIntact', !!s12.MBC.config
    && typeof s12.MBC.config.loadMiddleBrainConfigUI === 'function'
    && typeof s12.MBC.config.middleBrainImageMode === 'function', '层契约被破坏');

  console.log('\n' + (failures ? '✖ ' + failures + ' 项失败' : '✔ 全部通过'));
  if (failures) process.exitCode = 1;
  /* 自然退出（本测试不持有 server/child/timer/socket；无 process.exit 掩盖泄漏） */
})();
