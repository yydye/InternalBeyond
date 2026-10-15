'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, '');
const css = read('assets/css/ui-overlay-primitives.css').replace(/\/\*[\s\S]*?\*\//g, '');
const js = read('assets/js/ui-overlay-lifecycle.js').replace(/^\uFEFF/, '');
const fixture = read('tests/fixtures/feedback-overlays/index.html');
const fixtureCss = read('tests/fixtures/feedback-overlays/fixture.css');
const widgetsCss = read('assets/css/core/widgets.css');
const core = read('assets/js/core.js');
const errorSource = read('assets/js/error-catalog.js');
const tokenSource = read('assets/css/core.css');
let passed = 0;

function check(name, condition, detail = '') {
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ''}`);
  passed += 1;
  console.log(`PASS ${name}`);
}

function tokenNames(source) {
  return [...new Set([...source.matchAll(/var\((--ib-token-[\w-]+)/g)].map(match => match[1]))];
}

const declaredTokens = new Set([...tokenSource.matchAll(/(--ib-token-[\w-]+)\s*:/g)].map(match => match[1]));
check('new overlay CSS uses declared D1 semantic roles', tokenNames(css).length > 0 && tokenNames(css).every(token => declaredTokens.has(token)));
check('overlay CSS raw hex and rgba counts are zero', !/#[\da-f]{3,8}\b/i.test(css) && !/\brgba?\s*\(/i.test(css));
check('overlay CSS radius, elevation and motion values are token-backed',
  [...css.matchAll(/border-radius\s*:\s*([^;}]+)/gi)].every(m => /^var\(--ib-token-radius-[\w-]+\)$/.test(m[1].trim()))
  && [...css.matchAll(/box-shadow\s*:\s*([^;}]+)/gi)].every(m => /^var\(--ib-token-elevation-[\w-]+\)$/.test(m[1].trim()))
  && !/(?:transition(?:-duration)?|animation(?:-duration)?)\s*:[^;}]*\b\d+(?:\.\d+)?(?:ms|s)\b/i.test(css));
check('overlay CSS z-indexes use semantic layer tokens only', [...css.matchAll(/z-index\s*:\s*([^;}]+)/gi)].every(m => /^var\(--ib-token-layer-[\w-]+\)$/.test(m[1].trim())));
check('overlay CSS has no direct legacy Glass consumer', !/--glass-|glass-card|backdrop-filter/i.test(css));
check('dialog backdrop and surface use the D1 dialog/overlay roles', /dialog\.ib-overlay-dialog::backdrop\s*\{[^}]*background:\s*var\(--ib-token-overlay\)/s.test(css) && /dialog\.ib-overlay-dialog\s*\{[^}]*background:\s*var\(--ib-token-dialog\)/s.test(css));
check('popover uses the anchored, nonmodal D1 popover roles', /\[popover\]\.ib-overlay-popover\s*\{[^}]*background:\s*var\(--ib-token-popover\)/s.test(css) && /position-area:\s*block-end span-inline-end/.test(fixtureCss));
check('native layers and reduced motion are explicit', /popover="auto"/.test(fixture) && /<dialog/.test(fixture) && /prefers-reduced-motion:\s*reduce/.test(css));
check('fixture does not bulk-migrate or load production pages', !/InternalBeyond\.html|navigation-shell|data-page=|navTo\(/.test(fixture));
check('fixture labels dialogs and uses ordinary popover semantics', /<dialog[^>]+aria-labelledby=/.test(fixture) && /role="menu"|role="menuitem"/.test(fixture) === false);
const fixtureIds = new Set([...fixture.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const nativeTargets = [
  ...[...fixture.matchAll(/\bpopovertarget="([^"]+)"/g)].map(match => match[1]),
  ...[...fixture.matchAll(/\bdata-ib-dialog-open="([^"]+)"/g)].map(match => match[1])
];
check('native trigger relationships resolve to real overlay targets', nativeTargets.length >= 5 && nativeTargets.every(id => fixtureIds.has(id)));
check('fixture covers safe, busy and destructive dismissal policies', /id="choice-dialog"[^>]+data-dismissible="true"/.test(fixture) && /id="busy-dialog"[^>]+data-cancel-while-busy="false"/.test(fixture) && /id="destructive-dialog"[^>]+data-dismissible="false"/.test(fixture));
check('fixture has no failure Toast example', !/toast\.(?:error|failure)|toast\([^)]*(?:failed|failure|error)/i.test(fixture + read('tests/fixtures/feedback-overlays/fixture.js')));
check('new helper delegates popover dismissal to native auto Popover and dialog behavior to native dialog', /popover=\"auto\"/.test(fixture) && /dialog\.showModal\(\)/.test(js) && /addEventListener\('cancel'/.test(js));
check('new helper defines safe initial focus, dismissal, busy submit and return focus', /data-destructive/.test(js) && /isDismissable/.test(js) && /setBusy/.test(js) && /restoreFocus/.test(js));
check('Dialog keyboard fallback wraps Tab and Shift+Tab at both focus boundaries', /event\.shiftKey && active === first/.test(js) && /!event\.shiftKey && active === last/.test(js));
check('new helper does not add a broad app aria-hidden/inert sweep', !/document\.body\.setAttribute\(['"]aria-hidden|document\.body\.inert\s*=/.test(js));
check('Toast layer uses the D1 toast slot and never intercepts pointer input', /\.toast-stack\{[^}]*z-index:var\(--ib-token-layer-toast\)[^}]*pointer-events:none/s.test(widgetsCss));
check('short-height opt-in Dialog reserves a token-sized region for a nonblocking Toast', /\.toast-stack\[data-modal-toast="true"\]\{bottom:var\(--ib-token-space-md\)\}/.test(widgetsCss) && /\.ib-primitives dialog\.ib-overlay-dialog\.ib-toast-present[\s\S]*max-block-size:calc\(100dvh - \(2 \* var\(--ib-token-space-md\)\) - \(2 \* var\(--ib-token-space-xxl\)\)\)/.test(widgetsCss));
check('Toast rehomes into an active native Dialog and restores after close', /_attachToDialog/.test(core) && /_restoreFromDialog/.test(core) && /ib-toast-present/.test(core) && /_attachToDialog\(dialog\)/.test(js) && /_restoreFromDialog\(dialog\)/.test(js));

class FakeStyle {
  constructor() { this.display = ''; this.cssText = ''; }
  set cssText(value) {
    this._cssText = String(value || '');
    const match = this._cssText.match(/(?:^|;)\s*display\s*:\s*([^;]+)/i);
    if (match) this.display = match[1].trim();
  }
  get cssText() { return this._cssText || ''; }
  setProperty(name, value) { this[name] = String(value); }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = Object.create(null);
    this.dataset = Object.create(null);
    this.style = new FakeStyle();
    this.className = '';
    this.id = '';
    this.hidden = false;
    this.disabled = false;
    this._textContent = '';
    this.listeners = Object.create(null);
    this.popoverOpen = false;
    this.classList = {
      add: name => { if (!this.className.split(/\s+/).includes(name)) this.className = `${this.className} ${name}`.trim(); },
      remove: name => { this.className = this.className.split(/\s+/).filter(value => value && value !== name).join(' '); },
      contains: name => this.className.split(/\s+/).includes(name)
    };
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
  }
  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) { delete this.attributes[name]; }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  dispatch(name, event = {}) { for (const listener of this.listeners[name] || []) listener.call(this, event); }
  showPopover() { this.popoverOpen = true; }
  hidePopover() { this.popoverOpen = false; }
  matches(selector) {
    if (selector === ':popover-open') return this.popoverOpen;
    if (selector === ':modal') return this.tagName === 'DIALOG' && this.open === true;
    return false;
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (selector[0] === '.' && node.className.split(/\s+/).includes(selector.slice(1))) return node;
      if (selector === 'dialog' && node.tagName === 'DIALOG') return node;
      if (selector === '[inert]' && node.hasAttribute('inert')) return node;
      node = node.parentElement;
    }
    return null;
  }
  get parentElement() { return this.parentNode; }
  focus() { this.ownerDocument.activeElement = this; }
  get isConnected() { return !!this.parentNode || this === this.ownerDocument.body; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  set textContent(value) {
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
    this._textContent = String(value == null ? '' : value);
  }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }
  get innerText() {
    if (this.hidden || this.style.display === 'none') return '';
    return this._textContent + this.children.map(child => child.innerText).join('');
  }
  set innerHTML(value) { this.textContent = value; }
  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all[0] || null;
  }
  querySelectorAll(selector) {
    const matches = [];
    const match = node => {
      if (selector[0] === '.') return node.className.split(/\s+/).includes(selector.slice(1));
      if (selector[0] === '#') return node.id === selector.slice(1);
      if (selector[0] === '[') {
        const attr = selector.slice(1, -1).split('=')[0];
        return node.hasAttribute(attr);
      }
      return node.tagName.toLowerCase() === selector.toLowerCase();
    };
    const visit = node => node.children.forEach(child => { if (match(child)) matches.push(child); visit(child); });
    visit(this);
    return matches;
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body', this);
    this.activeElement = this.body;
  }
  createElement(tagName) { return new FakeElement(tagName, this); }
  querySelectorAll(selector) {
    const matches = [];
    const visit = node => node.children.forEach(child => {
      if (selector === 'dialog[open]' && child.tagName === 'DIALOG' && child.open) matches.push(child);
      visit(child);
    });
    visit(this.body);
    return matches;
  }
  getElementById(id) {
    let found = null;
    const visit = node => {
      if (node.id === id) found = node;
      node.children.forEach(visit);
    };
    visit(this.body);
    return found;
  }
}

async function run() {
  const document = new FakeDocument();
  const window = {};
  const timers = [];
  const errorContext = {
    window, document, console, Date, Math, String, Object, RegExp, Error, Promise, JSON,
    setTimeout(callback, delay) { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; }
  };
  vm.runInNewContext(errorSource, errorContext, { filename: 'error-catalog.js' });
  const IBERR = window.IBERR;
  const secret = 'sk-D2C-SECRET-SENTINEL-938475';
  const model = IBERR.model('network', {
    endpoint: 'https://service.example/v1/chat?key=' + secret,
    detail: 'Authorization: Bearer ' + secret,
    requestId: 'req_d2c_12345678'
  });
  const detailsText = IBERR.detailsText(model);
  check('IBERR remains the sole model and reuses redacted technicalDetails', !!model.code && !detailsText.includes(secret) && !detailsText.includes('Bearer ' + secret));

  let retryResolve;
  let retryCalls = 0;
  const retryCard = IBERR.show(model, { onRetry: function () { retryCalls += 1; return new Promise(resolve => { retryResolve = resolve; }); } });
  const detailsButton = retryCard.querySelector('.ib-err-toggle');
  const detailsRegion = retryCard.querySelector('.ib-err-details');
  const retryButton = retryCard.querySelector('.ib-err-retry');
  check('Error Disclosure defaults L3 to hidden with disclosure ARIA', detailsRegion.hidden === true && detailsButton.getAttribute('aria-expanded') === 'false' && detailsButton.getAttribute('aria-controls') === detailsRegion.id && !!document.getElementById(detailsRegion.id));
  check('L3 details are absent from default visible text', !retryCard.innerText.includes('HTTP 状态') && !retryCard.innerText.includes('请求 ID'));
  const focusBeforeDisclosure = document.activeElement;
  detailsButton.onclick();
  check('detail activation synchronizes expanded and visible state without moving focus', detailsButton.getAttribute('aria-expanded') === 'true' && detailsRegion.hidden === false && retryCard.innerText.includes('请求 ID') && document.activeElement === focusBeforeDisclosure);
  detailsButton.onclick();
  check('detail collapse restores the default L1 presentation', detailsButton.getAttribute('aria-expanded') === 'false' && detailsRegion.hidden === true);
  retryButton.onclick();
  retryButton.onclick();
  check('async retry exposes a real busy state and blocks duplicate invocation', retryCalls === 1 && retryButton.disabled && retryButton.getAttribute('aria-busy') === 'true' && retryCard.getAttribute('aria-busy') === 'true');
  retryResolve(true);
  await Promise.resolve();
  await Promise.resolve();
  check('successful recovery removes the original disclosure after completion', retryCard.parentNode === null);

  let failedRetryResolve;
  const failedRetryCard = IBERR.show(IBERR.model('timeout', { detail: 'temporary timeout' }), {
    onRetry: function () { return new Promise(resolve => { failedRetryResolve = resolve; }); }
  });
  const failedRetryButton = failedRetryCard.querySelector('.ib-err-retry');
  failedRetryButton.onclick();
  failedRetryResolve(false);
  await Promise.resolve();
  await Promise.resolve();
  check('unsuccessful retry restores a usable Error Disclosure instead of reporting success', failedRetryCard.parentNode !== null && !failedRetryButton.disabled && failedRetryButton.getAttribute('aria-busy') === null);
  failedRetryCard.querySelector('.ib-err-close').onclick();

  const syncFailureCard = IBERR.show(IBERR.model('provider', { detail: 'temporary service failure' }), { onRetry: function () { return false; } });
  syncFailureCard.querySelector('.ib-err-retry').onclick();
  check('synchronous retry refusal keeps the original recovery explanation visible', syncFailureCard.parentNode !== null && !syncFailureCard.querySelector('.ib-err-retry').disabled);
  syncFailureCard.querySelector('.ib-err-close').onclick();

  const fixedModel = IBERR.model('auth', { reason: 'missing-key', detail: 'Authorization: Bearer ' + secret });
  const fixedCard = IBERR.show(fixedModel, { onRetry: function () { throw new Error('must not run'); } });
  check('retry action is absent when IBERR says the category is not retryable', fixedModel.retryable === false && fixedCard.querySelector('.ib-err-retry') === null);

  const toastStart = core.indexOf('var _toastStack=null;');
  const toastMarker = core.slice(toastStart).search(/\r?\n\r?\n\/\* GUIDE TOC/);
  const toastEnd = toastMarker < 0 ? -1 : toastStart + toastMarker;
  assert.ok(toastStart >= 0 && toastEnd > toastStart, 'toast implementation extraction boundary exists');
  const toastDocument = new FakeDocument();
  const toastWindow = {};
  const toastTimers = [];
  const toastContext = {
    window: toastWindow, document: toastDocument, String, setTimeout(callback, delay) { toastTimers.push({ callback, delay }); return toastTimers.length; }
  };
  vm.runInNewContext(core.slice(toastStart, toastEnd) + '\nwindow.toast=toast;', toastContext, { filename: 'core-toast.js' });
  const focusBefore = toastDocument.activeElement;
  toastWindow.toast.success('Saved');
  const stack = toastDocument.getElementById('toast-stack');
  const savedToast = stack.lastChild;
  check('new Toast API is explicitly success-only, polite and non-focus-stealing', savedToast.dataset.toastIntent === 'success' && stack.getAttribute('role') === 'status' && stack.getAttribute('aria-live') === 'polite' && toastDocument.activeElement === focusBefore);
  check('Toast stays on its semantic fixed layer and keeps legacy-compatible timing', !stack.hasAttribute('popover') && toastTimers[0].delay === 2800);
  toastWindow.toast('Legacy failure remains callable');
  const legacyToast = stack.lastChild;
  check('legacy direct Toast callers remain supported and distinguishable', legacyToast.dataset.toastIntent === 'legacy');
  for (let i = 0; i < 5; i += 1) toastWindow.toast.success('Saved ' + i);
  check('multiple toasts are capped predictably', stack.children.length === 4 && stack.children.every(child => child.dataset.toastIntent === 'success'));
  toastTimers.forEach(timer => timer.callback());
  check('toast timeout removes items without focus or layer residue', stack.children.length === 0 && !stack.hasAttribute('popover'));

  toastTimers.length = 0;
  const nativeHost = toastDocument.createElement('div');
  nativeHost.className = 'ib-primitives';
  toastDocument.body.appendChild(nativeHost);
  const nativeDialog = toastDocument.createElement('dialog');
  nativeDialog.className = 'ib-overlay-dialog';
  nativeDialog.open = true;
  nativeHost.appendChild(nativeDialog);
  toastWindow.toast.success('Saved during a decision');
  const modalToast = stack.lastChild;
  check('Toast moves into the active native Dialog layer without popover dismissal semantics', modalToast.parentNode === stack && stack.parentNode === nativeDialog && !stack.hasAttribute('popover') && nativeDialog.classList.contains('ib-toast-present') && stack.getAttribute('data-modal-toast') === 'true');
  toastWindow.toast.success('Updated during the decision');
  const replacedToast = stack.lastChild;
  check('modal Toast remains a single latest confirmation', stack.children.length === 1 && stack.firstChild === replacedToast && replacedToast.textContent === 'Updated during the decision');
  nativeDialog.open = false;
  toastWindow.toast._restoreFromDialog(nativeDialog);
  check('Toast returns to the page fixed layer after Dialog close', stack.parentNode === toastDocument.body && !stack.hasAttribute('popover') && !nativeDialog.classList.contains('ib-toast-present'));
  toastTimers.forEach(timer => timer.callback());

check('native Dialog lifecycle uses semantic focus, modal, and submit policies', /showModal\(\)/.test(js) && /aria-modal/.test(js) && /data-dismissible/.test(fixture) && /data-dialog-submit/.test(fixture));
  console.log(`UI overlay structural and lifecycle checks: ${passed} passed`);
}

run().catch(error => { console.error(error); process.exitCode = 1; });
