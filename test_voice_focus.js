'use strict';

/* Voice Call modal focus lifecycle regression test.
   The modal must capture the opener for focus restoration, move focus into the
   modal on open (so keyboard nav works), and restore focus to the opener on close
   (so focus never remains trapped in an aria-hidden tree, which triggers browser
   accessibility warnings and breaks screen reader navigation).

   Harness notes:
   - call.js runs inside an IIFE. Its private state (_voiceCallOpener,
     _incomingCallOpener, current) is NOT reachable from the VM sandbox, so this
     harness asserts ONLY observable behavior — the real document.activeElement
     after open/close — never the closure internals.
   - window.setTimeout is used by call.js to move focus after the modal opens; the
     fake window must expose a working setTimeout (routed to the same queue the
     test flushes) or the focus hand-off never runs.
   - The public close path for an active call is hangupVoiceCall() (which delegates
     to closeVoiceCall after a short timeout), so the harness flushes that too. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadCall() {
  const elements = new Map();
  let docActiveElement = null;
  function el(tag) {
    const attrs = {};
    const style = {};
    const self = {};
    self.id = ''; self.tagName = tag || 'DIV'; self.hidden = false; self.inert = false;
    self.textContent = ''; self.innerHTML = ''; self.className = ''; self.value = '';
    self.style = style; self.dataset = {};
    /* classList must read/write the element's real className (closure over self),
       so add/remove/toggle actually mutate it and contains() can match it. */
    self.classList = {
      add(c) { if (!self.classList.contains(c)) self.className = (self.className + ' ' + c).trim(); },
      remove(c) { self.className = self.className.replace(new RegExp('\\b' + c + '\\b', 'g'), '').trim(); },
      toggle(c) { self.classList.contains(c) ? self.classList.remove(c) : self.classList.add(c); },
      contains(c) { return new RegExp('\\b' + c + '\\b').test(self.className); }
    };
    self.children = [];
    self.appendChild = function (c) { self.children.push(c); };
    self.setAttribute = function (k, v) { attrs[k] = String(v); };
    self.getAttribute = function (k) { return attrs[k] || null; };
    self.focus = function () { docActiveElement = self; };
    self.blur = function () { if (docActiveElement === self) docActiveElement = doc.body; };
    self.querySelector = function (sel) {
      /* Minimal selector support for .class matching */
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        for (const ch of self.children) if (ch.classList.contains(cls)) return ch;
      }
      return null;
    };
    self.contains = function (other) { return self === other || self.children.some(c => c === other || (c.contains && c.contains(other))); };
    return self;
  }

  const body = el('BODY');
  body.id = 'body';
  const voiceModal = el('DIV');
  voiceModal.id = 'voice-call-modal';
  voiceModal.hidden = true;
  voiceModal.setAttribute('aria-hidden', 'true');
  const muteBtn = el('BUTTON');
  muteBtn.id = 'voice-call-mute';
  voiceModal.appendChild(muteBtn);
  const incomingOverlay = el('DIV');
  incomingOverlay.id = 'incoming-call-overlay';
  incomingOverlay.hidden = true;
  incomingOverlay.setAttribute('aria-hidden', 'true');
  const acceptBtn = el('BUTTON');
  acceptBtn.className = 'incoming-call-accept';
  incomingOverlay.appendChild(acceptBtn);
  const launchBtn = el('BUTTON');
  launchBtn.className = 'voice-call-launch';
  launchBtn.id = 'voice-call-launch-full';

  for (const e of [voiceModal, incomingOverlay, launchBtn]) body.appendChild(e);
  for (const id of ['voice-call-state', 'voice-call-duration', 'voice-call-wave', 'voice-call-meter-fill',
                    'voice-call-role-name', 'voice-call-transcript', 'voice-call-reply', 'voice-call-error',
                    'voice-call-avatar', 'voice-call-speaker',
                    'incoming-call-role-name', 'incoming-call-msg', 'incoming-call-reason', 'incoming-call-avatar']) {
    const dummy = el();
    dummy.id = id;
    elements.set(id, dummy);
  }
  elements.set('voice-call-modal', voiceModal);
  elements.set('voice-call-mute', muteBtn);
  elements.set('incoming-call-overlay', incomingOverlay);
  elements.set('voice-call-launch-full', launchBtn);
  elements.set('body', body);

  const doc = {
    body,
    get activeElement() { return docActiveElement || body; },
    set activeElement(el) { docActiveElement = el; },
    getElementById: (id) => elements.get(id) || null,
    querySelector: (sel) => {
      /* Only an element still in the document and not hidden is a valid fallback,
         matching real DOM querySelector semantics. */
      if (sel === '.voice-call-launch:not([hidden])') return (launchBtn.hidden || !body.contains(launchBtn)) ? null : launchBtn;
      return null;
    },
    contains(node) { return node === body || body.contains(node); },
    createElement: (tag) => el(tag)
  };
  docActiveElement = body;

  const win = { IB: { expose(name, api) { win.IB[name] = api; } } };
  const timeouts = [];
  const sandbox = {
    window: win,
    document: doc,
    performance: { now: () => Date.now() },
    console: { warn() {}, log() {}, error() {} },
    setInterval: () => 0, clearInterval() {},
    setTimeout: (fn, ms) => { const id = timeouts.length; timeouts.push(fn); return id; },
    clearTimeout(id) { const i = Number(id); if (Number.isInteger(i)) delete timeouts[i]; },
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Blob: function () {}, Audio: function () { return { addEventListener() {}, play: () => Promise.resolve(), pause() {} }; },
    ArrayBuffer, Uint8Array, Int16Array, Math, Date, Number, String, JSON, isFinite,
    WebSocket: function () { this.readyState = 0; this.send = function () {}; this.close = function () {}; },
    navigator: { mediaDevices: { getUserMedia: () => Promise.reject(new Error('mic stub')) } },
    AudioContext: function () { this.state = 'suspended'; this.resume = () => Promise.resolve(); this.close = () => Promise.resolve(); this.createMediaStreamSource = () => ({ connect() {} }); },
    AudioWorkletNode: function () { this.port = { onmessage: null }; this.disconnect = function () {}; },
    MediaStream: function () { this.getAudioTracks = () => []; }
  };
  /* call.js calls window.setTimeout / window.clearTimeout for the post-open focus
     hand-off. The fake window must expose them or the focus never moves. */
  win.setTimeout = sandbox.setTimeout;
  win.clearTimeout = sandbox.clearTimeout;
  win.MediaSource = { isTypeSupported: () => false };
  sandbox.MediaSource = win.MediaSource;
  sandbox.globalThis = sandbox;
  sandbox.activeFriendId = 'test_role';
  sandbox.apiConfigs = [{ id: 'test_role', nickname: 'Test', voice: {} }];
  sandbox.activeThreadId = null;
  sandbox.toast = () => {};

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'assets/js/communication/call.js'), 'utf8'), sandbox, { filename: 'call.js' });
  const flushTimeouts = () => { for (let i = 0; i < timeouts.length; i++) { const fn = timeouts[i]; if (typeof fn === 'function') { timeouts[i] = null; fn(); } } timeouts.length = 0; };
  return { win, sandbox, doc, voiceModal, muteBtn, incomingOverlay, acceptBtn, launchBtn, body, flushTimeouts };
}

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.error('  FAIL  ' + name + '  -> ' + (e && e.message || e)); }
}

/* `inModal` reports whether an element lives inside the (aria-hidden) voice modal. */
function inModal(voiceModal, el) { return voiceModal.contains(el); }

/* ── 1. Opening the voice modal moves focus into the modal (first control) ── */
check('opening the modal moves focus to the mute button', () => {
  const { win, muteBtn, doc, launchBtn, flushTimeouts } = loadCall();
  launchBtn.focus();
  assert.strictEqual(doc.activeElement, launchBtn, 'launch button should be focused before open');
  win.startVoiceCallFor('test_role', {});
  flushTimeouts();
  assert.strictEqual(doc.activeElement, muteBtn, 'focus must move to the mute button');
  assert.strictEqual(win.IB.voiceCall.getCurrent() !== null, true, 'a live call should be running');
});

/* ── 2. Closing the modal restores focus to the captured opener ── */
check('closeVoiceCall restores focus to the original opener', () => {
  const { win, launchBtn, doc, muteBtn, flushTimeouts } = loadCall();
  launchBtn.focus();
  win.startVoiceCallFor('test_role', {});
  flushTimeouts();
  assert.strictEqual(doc.activeElement, muteBtn, 'modal opened, focus on mute button');
  win.hangupVoiceCall();
  flushTimeouts();
  assert.strictEqual(doc.activeElement, launchBtn, 'focus must return to the launch button');
});

/* ── 3. ARIA state synchronizes, and no focused element is left inside the modal ── */
check('aria-hidden is false when open, true when closed, and no focus trapped inside', () => {
  const { win, voiceModal, muteBtn, doc, launchBtn, flushTimeouts } = loadCall();
  assert.strictEqual(voiceModal.getAttribute('aria-hidden'), 'true', 'modal starts hidden');
  assert.strictEqual(voiceModal.hidden, true);
  launchBtn.focus();
  win.startVoiceCallFor('test_role', {});
  flushTimeouts();
  assert.strictEqual(voiceModal.getAttribute('aria-hidden'), 'false', 'modal aria-hidden must be false when open');
  assert.strictEqual(voiceModal.hidden, false);
  assert.strictEqual(inModal(voiceModal, doc.activeElement), true, 'focus is inside the modal while open');
  win.hangupVoiceCall();
  flushTimeouts();
  assert.strictEqual(voiceModal.getAttribute('aria-hidden'), 'true', 'modal aria-hidden must be true when closed');
  assert.strictEqual(voiceModal.hidden, true);
  assert.strictEqual(inModal(voiceModal, doc.activeElement), false, 'no focused element may remain inside an aria-hidden modal');
});

/* ── 4. Fallback is safe if the opener was removed from the DOM ── */
check('closeVoiceCall falls back safely if opener was removed', () => {
  const { win, launchBtn, doc, body, flushTimeouts } = loadCall();
  launchBtn.focus();
  win.startVoiceCallFor('test_role', {});
  flushTimeouts();
  /* Simulate the opener being removed (page navigation, DOM update). */
  const idx = body.children.indexOf(launchBtn);
  if (idx >= 0) body.children.splice(idx, 1);
  win.hangupVoiceCall();
  flushTimeouts();
  /* No visible launch button remains, so focus should land on body (safe fallback),
     not throw, and never stay trapped in the hidden modal. */
  assert.strictEqual(doc.activeElement, body, 'focus must land on the body fallback');
});

/* ── 5. Incoming call overlay also captures and restores focus ── */
check('offerIncoming captures opener and moves focus to accept button', () => {
  const { win, incomingOverlay, acceptBtn, launchBtn, doc, flushTimeouts } = loadCall();
  launchBtn.focus();
  win.offerIncomingCall({ roleId: 'test_role', roleName: 'Test', openingMessage: 'Hello' });
  flushTimeouts();
  assert.strictEqual(incomingOverlay.getAttribute('aria-hidden'), 'false');
  assert.strictEqual(incomingOverlay.hidden, false);
  assert.strictEqual(doc.activeElement, acceptBtn, 'focus must move to accept button');
});

check('dismissIncoming restores focus to the opener', () => {
  const { win, launchBtn, doc, acceptBtn, flushTimeouts } = loadCall();
  launchBtn.focus();
  win.offerIncomingCall({ eventId: 'ev1', roleId: 'test_role', roleName: 'Test' });
  flushTimeouts();
  assert.strictEqual(doc.activeElement, acceptBtn);
  win.dismissIncomingCall('ev1');
  assert.strictEqual(doc.activeElement, launchBtn, 'focus must return to the original opener');
});

/* ── 6. Repeated open/close cycles do not leak focus state ── */
check('repeated open/close cycles remain stable', () => {
  const { win, launchBtn, muteBtn, doc, flushTimeouts } = loadCall();
  for (let i = 0; i < 3; i++) {
    launchBtn.focus();
    win.startVoiceCallFor('test_role', {});
    flushTimeouts();
    assert.strictEqual(doc.activeElement, muteBtn, 'cycle ' + i + ': focus on mute');
    win.hangupVoiceCall();
    flushTimeouts();
    assert.strictEqual(doc.activeElement, launchBtn, 'cycle ' + i + ': focus restored');
  }
});

/* ── 7. body is not captured as opener; close still succeeds with a visible fallback ── */
check('opener = document.body is not captured; closeVoiceCall still succeeds', () => {
  const { win, launchBtn, doc, body, flushTimeouts } = loadCall();
  body.focus();
  assert.strictEqual(doc.activeElement, body);
  win.startVoiceCallFor('test_role', {});
  flushTimeouts();
  /* Since the opener is body (not captured), focus moves into the modal on open. */
  assert.notStrictEqual(doc.activeElement, body, 'focus should have moved into the modal');
  win.hangupVoiceCall();
  flushTimeouts();
  /* No opener was captured, so the fallback (visible launch button) takes focus. */
  assert.strictEqual(doc.activeElement, launchBtn, 'focus must land on the visible launch fallback');
});

console.log('\n' + (fail === 0 ? 'Voice focus lifecycle test passed ✔ (' + pass + ')' : 'Voice focus lifecycle test FAILED (' + fail + ')'));
process.exit(fail ? 1 : 0);
