'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const deckSource = fs.readFileSync(path.join(ROOT, 'assets/js/chat-image-deck.js'), 'utf8');
const managerSource = fs.readFileSync(path.join(ROOT, 'assets/js/voicebox-profile-manager.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(ROOT, 'assets/js/bridge.js'), 'utf8');
const tauriHostSource = fs.readFileSync(path.join(ROOT, 'src-tauri/src/lib.rs'), 'utf8');

class FakeClassList {
  constructor(element) { this.element = element; }
  _items() { return String(this.element.className || '').split(/\s+/).filter(Boolean); }
  add(name) { const items = this._items(); if (!items.includes(name)) items.push(name); this.element.className = items.join(' '); }
  remove(name) { this.element.className = this._items().filter(item => item !== name).join(' '); }
  contains(name) { return this._items().includes(name); }
  toggle(name, force) {
    const add = force === undefined ? !this.contains(name) : !!force;
    if (add) this.add(name); else this.remove(name);
    return add;
  }
}

class FakeStyle {
  constructor() { this.values = Object.create(null); }
  setProperty(name, value) { this.values[name] = String(value); }
  removeProperty(name) { delete this.values[name]; }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.attributes = Object.create(null);
    this.dataset = Object.create(null);
    this.style = new FakeStyle();
    this.classList = new FakeClassList(this);
    this._className = '';
    this._textContent = '';
    this.listeners = new Map();
    this.complete = true;
    this.naturalWidth = 320;
    this.naturalHeight = 200;
    this.disabled = false;
  }
  get id() { return this.attributes.id || ''; }
  set id(value) { this.setAttribute('id', value); }
  get className() { return this._className; }
  set className(value) { this._className = String(value || ''); }
  get parentElement() { return this.parentNode; }
  get isConnected() { return !!(this.ownerDocument && this.ownerDocument.documentElement.contains(this)); }
  get textContent() { return this._textContent; }
  set textContent(value) {
    this._textContent = String(value == null ? '' : value);
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, anchor) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = anchor ? this.children.indexOf(anchor) : -1;
    child.parentNode = this;
    if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  replaceChild(next, previous) {
    const index = this.children.indexOf(previous);
    if (index < 0) throw new Error('child not found');
    if (next.parentNode) next.parentNode.removeChild(next);
    next.parentNode = this;
    this.children[index] = next;
    previous.parentNode = null;
    return previous;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(node) {
    if (node === this) return true;
    return this.children.some(child => child.contains(node));
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = value;
    if (name.indexOf('data-') === 0) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = String(value);
    }
  }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name.indexOf('data-') === 0) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      delete this.dataset[key];
    }
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (selector === '[data-msg-id]' && (child.hasAttribute('data-msg-id') || child.dataset.msgId)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type);
    if (listeners) listeners.delete(listener);
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 320, height: 200 }; }
  focus() {}
}

class FakeDocument {
  constructor() {
    this.readyState = 'complete';
    this.listeners = new Map();
    this.documentElement = new FakeElement('html', this);
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }
  createElement(tagName) { return new FakeElement(tagName, this); }
  getElementById(id) {
    const visit = node => {
      if (node.id === id) return node;
      for (const child of node.children) { const found = visit(child); if (found) return found; }
      return null;
    };
    return visit(this.documentElement);
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type);
    if (listeners) listeners.delete(listener);
  }
}

function loadChatDeck() {
  const document = new FakeDocument();
  const full = document.createElement('div'); full.id = 'chat-full-messages'; document.body.appendChild(full);
  const mini = document.createElement('div'); mini.id = 'chat-messages'; document.body.appendChild(mini);
  const frames = new Map();
  const intervals = new Map();
  let nextHandle = 0;
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; FakeMutationObserver.instances.push(this); }
    observe(target, options) { this.targets.push({ target, options }); }
    disconnect() { this.disconnected = true; this.targets = []; }
    notify(records) { if (!this.disconnected) this.callback(records); }
  }
  FakeMutationObserver.instances = [];
  const namespace = { expose(name, api) { namespace[name] = api; } };
  const window = {
    IB: namespace,
    MutationObserver: FakeMutationObserver,
    requestAnimationFrame(callback) { const id = ++nextHandle; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback) { const id = ++nextHandle; frames.set(id, callback); return id; },
    clearTimeout(id) { frames.delete(id); },
    setInterval(callback) { const id = ++nextHandle; intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); }
  };
  const context = { window, document, console, Date, Object, Array, String, Number, Math, isFinite };
  vm.runInNewContext(deckSource, context, { filename: 'assets/js/chat-image-deck.js' });
  return {
    document, window, full, mini, observers: FakeMutationObserver.instances, frames, intervals,
    api: namespace.chatImageDeck,
    flushFrames() {
      while (frames.size) {
        const pending = Array.from(frames.values());
        frames.clear();
        pending.forEach(callback => callback());
      }
    },
    mutate(target) {
      const records = [{ target, addedNodes: [], removedNodes: [] }];
      FakeMutationObserver.instances.forEach(observer => observer.notify(records));
      this.flushFrames();
    },
    addMessage(container, msgId) {
      const row = this.createMessage(msgId);
      container.appendChild(row);
      return row;
    },
    createMessage(msgId) {
      const row = document.createElement('div');
      row.setAttribute('data-msg-id', msgId);
      for (let i = 0; i < 3; i++) {
        const image = document.createElement('img');
        image.className = 'chat-bubble-img';
        image.complete = true;
        row.appendChild(image);
      }
      return row;
    }
  };
}

function findClass(root, className) {
  if (root.classList && root.classList.contains(className)) return root;
  for (const child of root.children || []) {
    const found = findClass(child, className);
    if (found) return found;
  }
  return null;
}

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'production function found: ' + name);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated production function: ' + name);
}

function makeUrlApi() {
  const created = [];
  const revoked = [];
  let sequence = 0;
  return {
    created,
    revoked,
    api: {
      createObjectURL(blob) { const url = 'blob:ib-audio-' + (++sequence); created.push({ url, blob }); return url; },
      revokeObjectURL(url) { revoked.push(url); }
    }
  };
}

function makeBridge(urls, options) {
  options = options || {};
  const state = { pendingAudio: [], requests: [] };
  const context = {
    URL: urls.api,
    Promise,
    TypeError,
    Headers: typeof Headers === 'function' ? Headers : undefined,
    window: { __IB_DEV_MODE__: false },
    ibBridgeToken() { return options.token === false ? '' : 'test-token'; },
    ibBridgeAssetUrl(pathname) { return 'http://bridge.test' + pathname; },
    fetch(input, requestOptions) {
      const headers = requestOptions && requestOptions.headers;
      const authorization = headers && typeof headers.get === 'function'
        ? headers.get('Authorization')
        : headers && headers.Authorization;
      state.requests.push({ input: String(input), authorization: authorization || '' });
      if (options.deferAudio && String(input).endsWith('/api/tts/audio')) {
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        state.pendingAudio.push({ resolve, input });
        return promise;
      }
      return Promise.resolve({ ok: true, blob: async () => ({ source: String(input) }) });
    }
  };
  vm.createContext(context);
  const helpers = [
    extractFunction(bridgeSource, 'ibBridgeReleaseAudio'),
    extractFunction(bridgeSource, 'ibBridgeFetch'),
    extractFunction(bridgeSource, 'ibBridgeLoadAudio')
  ].join('\n');
  vm.runInContext(helpers + '\nwindow.ibBridgeReleaseAudio=ibBridgeReleaseAudio;window.ibBridgeLoadAudio=ibBridgeLoadAudio;', context, { filename: 'bridge-audio-lifecycle.js' });
  return { context, window: context.window, state, urls };
}

function makeVoiceboxManager(options) {
  options = options || {};
  const urls = makeUrlApi();
  const bridge = makeBridge(urls, options);
  const audioInstances = [];
  class FakeAudio {
    constructor(src) {
      if (FakeAudio.throwNext) { FakeAudio.throwNext = false; throw new Error('audio-constructor-failure'); }
      this.src = src;
      this.listeners = new Map();
      this.pauseCalls = 0;
      this.loadCalls = 0;
      audioInstances.push(this);
    }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type, listener) { const listeners = this.listeners.get(type); if (listeners) listeners.delete(listener); }
    play() {
      if (FakeAudio.rejectNext) { FakeAudio.rejectNext = false; return Promise.reject(new Error('playback-failure')); }
      return Promise.resolve();
    }
    pause() { this.pauseCalls++; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() { this.loadCalls++; }
    dispatch(type) { const listeners = Array.from(this.listeners.get(type) || []); listeners.forEach(listener => listener({ type, target: this })); }
  }
  FakeAudio.throwNext = false;
  FakeAudio.rejectNext = false;
  const managerBase = 'http://bridge.test';
  async function managerFetch(input) {
    const route = String(input).slice(managerBase.length);
    let data;
    if (route === '/api/tts/voicebox/health') data = { ok: true };
    else if (route === '/api/tts/voicebox/profiles') data = { ok: true, profiles: [{ id: 'profile-1', name: 'test', voiceType: 'cloned', sampleCount: 1, defaultEngine: 'engine-1' }] };
    else if (route === '/api/tts/voicebox/capabilities') data = { ok: true, engines: { 'engine-1': { clone: true, models: [{ name: 'model-1', ibDefault: true, ibSelectable: true }] } } };
    else if (route === '/api/tts/voicebox/models') data = { ok: true, models: [{ name: 'model-1', downloaded: true }] };
    else if (route === '/api/tts') data = { ok: true, url: '/api/tts/audio' };
    else throw new Error('unexpected manager request: ' + route);
    return { ok: true, status: 200, json: async () => data };
  }
  const root = {
    URL: urls.api,
    IB: { bridge: { ttsPayload: () => ({ model: 'model-1' }) } },
    ibBridgeReleaseAudio: bridge.window.ibBridgeReleaseAudio,
    _ibVoiceboxProfiles: [],
    _ibVoiceboxProfilesStatus: 'unknown'
  };
  const document = { readyState: 'complete', getElementById() { return null; }, addEventListener() {}, removeEventListener() {} };
  const context = {
    window: root,
    document,
    IB: root.IB,
    URL: urls.api,
    Audio: FakeAudio,
    Promise,
    AbortController,
    String,
    Number,
    Array,
    Object,
    Math,
    Date,
    console,
    ibBridgeBase() { return managerBase; },
    ibBridgeFetch: managerFetch,
    ibBridgeLoadAudio: bridge.window.ibBridgeLoadAudio
  };
  vm.createContext(context);
  vm.runInContext(managerSource, context, { filename: 'assets/js/voicebox-profile-manager.js' });
  return { manager: root.IBVoiceboxProfileManager, root, bridge, urls, audioInstances, FakeAudio };
}

async function flushAsync() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

async function waitFor(predicate, message) {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await flushAsync();
  }
  assert.fail(message || 'condition did not become true');
}

test('chat image deck drops cache entries after repeated removal and observes container replacement', () => {
  const env = loadChatDeck();
  assert.equal(env.observers.length, 1);
  const initialTargets = env.observers[0].targets;
  assert.ok(initialTargets.some(item => item.target === env.full && item.options.subtree));
  assert.ok(initialTargets.some(item => item.target === env.mini && item.options.subtree));
  assert.ok(initialTargets.some(item => item.target === env.document.body && !item.options.subtree));

  for (let i = 0; i < 20; i++) {
    const msgId = 'message-' + i;
    const row = env.addMessage(env.full, msgId);
    env.mutate(env.full);
    assert.equal(env.api.decks().length, 1, 'message deck created: ' + msgId);
    assert.equal(env.api.indexOf(msgId), 0);
    env.full.removeChild(row);
    env.mutate(env.full);
    assert.equal(env.api.decks().length, 0, 'message record released: ' + msgId);
    assert.equal(env.api.indexOf(msgId), -1, 'cache key removed: ' + msgId);
  }

  const originalRow = env.addMessage(env.full, 'rerendered-message');
  env.mutate(env.full);
  const next = findClass(originalRow, 'chat-image-deck__nav--next');
  assert.ok(next);
  Array.from(next.listeners.get('click')).forEach(listener => listener({ stopPropagation() {} }));
  assert.equal(env.api.indexOf('rerendered-message'), 1);
  const rerenderedRow = env.createMessage('rerendered-message');
  env.full.replaceChild(rerenderedRow, originalRow);
  env.mutate(env.full);
  assert.equal(env.api.indexOf('rerendered-message'), 1, 'same message keeps its selected image across rerender');
  env.full.removeChild(rerenderedRow);
  env.mutate(env.full);
  assert.equal(env.api.indexOf('rerendered-message'), -1);

  const oldContainer = env.full;
  env.addMessage(oldContainer, 'before-container-replacement');
  env.mutate(oldContainer);
  assert.equal(env.api.decks().length, 1);
  const replacement = env.document.createElement('div');
  replacement.id = 'chat-full-messages';
  env.document.body.replaceChild(replacement, oldContainer);
  env.mutate(env.document.body);
  assert.equal(env.api.indexOf('before-container-replacement'), -1);
  assert.equal(env.api.decks().length, 0);
  const replacementObserver = env.addMessage(replacement, 'after-container-replacement');
  env.mutate(replacement);
  assert.equal(env.api.decks().length, 1);
  replacement.removeChild(replacementObserver);
  env.mutate(replacement);
  assert.equal(env.api.indexOf('after-container-replacement'), -1);
  assert.equal(env.api.decks().length, 0);

  env.api.destroy();
  assert.ok(env.observers.every(observer => observer.disconnected));
  assert.equal(env.intervals.size, 0);
  assert.equal(env.frames.size, 0);
});

test('bridge audio loader retains callback shape and releases URL when its consumer throws', async () => {
  const urls = makeUrlApi();
  const bridge = makeBridge(urls);
  assert.match(bridgeSource, /window\.ibBridgeLoadAudio\s*=\s*ibBridgeLoadAudio/);
  assert.equal(bridge.window.ibBridgeLoadAudio, bridge.context.ibBridgeLoadAudio);
  let failed = 0;
  bridge.window.ibBridgeLoadAudio('/api/tts/audio', () => { throw new Error('consumer-interrupted'); }, () => { failed++; });
  await flushAsync();
  assert.equal(urls.created.length, 1);
  assert.deepEqual(urls.revoked, [urls.created[0].url]);
  assert.equal(failed, 1);
  assert.equal(bridge.state.requests[0].authorization, 'Bearer test-token');
  assert.equal(bridge.state.requests[0].input.includes('test-token'), false);

  const publicBridgeUrl = 'http://bridge.test/api/tts/audio';
  assert.equal(bridge.window.ibBridgeReleaseAudio(publicBridgeUrl, false), false);
  assert.deepEqual(urls.revoked, [urls.created[0].url]);
});

test('bridge audio loader preserves the tokenless direct-URL callback contract', () => {
  const urls = makeUrlApi();
  const bridge = makeBridge(urls, { token: false });
  let result = null;
  bridge.window.ibBridgeLoadAudio('/api/tts/audio', (url, owned) => { result = { url, owned }; });
  assert.deepEqual(result, { url: 'http://bridge.test/api/tts/audio', owned: false });
  assert.equal(bridge.state.requests.length, 0);
  assert.equal(urls.created.length, 0);
});

test('Voicebox previews release Blob URLs on replacement, explicit stop, error, and end', async () => {
  const env = makeVoiceboxManager();
  assert.equal(await env.manager.refresh(), true);

  await env.manager.preview('profile-1', null, 'first preview', null);
  await waitFor(() => env.audioInstances.length === 1, 'first preview audio created');
  const firstAudio = env.audioInstances[0];
  const firstUrl = firstAudio.src;

  await env.manager.preview('profile-1', null, 'replacement preview', null);
  await waitFor(() => env.audioInstances.length === 2, 'replacement preview audio created');
  assert.ok(firstAudio.pauseCalls > 0);
  assert.equal(firstAudio.src, '');
  assert.deepEqual(env.urls.revoked.filter(url => url === firstUrl), [firstUrl]);

  const secondAudio = env.audioInstances[1];
  const secondUrl = secondAudio.src;
  env.manager.stopPreview();
  assert.ok(secondAudio.pauseCalls > 0);
  assert.equal(secondAudio.src, '');
  assert.deepEqual(env.urls.revoked.filter(url => url === secondUrl), [secondUrl]);
  env.manager.stopPreview();
  assert.deepEqual(env.urls.revoked.filter(url => url === secondUrl), [secondUrl], 'stop is idempotent');

  await env.manager.preview('profile-1', null, 'error preview', null);
  await waitFor(() => env.audioInstances.length === 3, 'error preview audio created');
  const errorAudio = env.audioInstances[2];
  const errorUrl = errorAudio.src;
  errorAudio.dispatch('error');
  assert.equal(errorAudio.src, '');
  assert.deepEqual(env.urls.revoked.filter(url => url === errorUrl), [errorUrl]);

  await env.manager.preview('profile-1', null, 'finished preview', null);
  await waitFor(() => env.audioInstances.length === 4, 'finished preview audio created');
  const endedAudio = env.audioInstances[3];
  const endedUrl = endedAudio.src;
  endedAudio.dispatch('ended');
  assert.equal(endedAudio.src, '');
  assert.deepEqual(env.urls.revoked.filter(url => url === endedUrl), [endedUrl]);
});

test('Windows host visibility follows minimized state through WebView2 IsVisible', () => {
  assert.match(tauriHostSource, /window\.on_window_event\(move \|event\|/);
  assert.match(tauriHostSource, /WindowEvent::Resized\(_\) \| WindowEvent::Focused\(_\)/);
  assert.match(tauriHostSource, /visibility_window\.is_minimized\(\)/);
  assert.match(tauriHostSource, /with_webview\(move \|webview\|/);
  assert.match(tauriHostSource, /controller\(\)\.SetIsVisible\(visible\)/);
});

test('interrupted audio fetch and rejected playback both release their object URLs', async () => {
  const env = makeVoiceboxManager({ deferAudio: true });
  assert.equal(await env.manager.refresh(), true);
  await env.manager.preview('profile-1', null, 'interrupted preview', null);
  await waitFor(() => env.bridge.state.pendingAudio.length === 1, 'audio fetch pending');
  env.manager.close();
  env.bridge.state.pendingAudio[0].resolve({ ok: true, blob: async () => ({ source: 'late audio' }) });
  await flushAsync();
  assert.equal(env.audioInstances.length, 0, 'closed manager does not start late audio');
  assert.equal(env.urls.created.length, 1);
  assert.deepEqual(env.urls.revoked, [env.urls.created[0].url]);

  const rejected = makeVoiceboxManager();
  assert.equal(await rejected.manager.refresh(), true);
  rejected.FakeAudio.rejectNext = true;
  await rejected.manager.preview('profile-1', null, 'rejected playback', null);
  await waitFor(() => rejected.audioInstances.length === 1, 'rejected playback element created');
  await flushAsync();
  assert.deepEqual(rejected.urls.revoked, [rejected.urls.created[0].url]);
  assert.equal(rejected.audioInstances[0].src, '');

  const constructorFailure = makeVoiceboxManager();
  assert.equal(await constructorFailure.manager.refresh(), true);
  constructorFailure.FakeAudio.throwNext = true;
  await constructorFailure.manager.preview('profile-1', null, 'constructor failure', null);
  await waitFor(() => constructorFailure.urls.created.length === 1, 'URL created before audio construction');
  await flushAsync();
  assert.equal(constructorFailure.audioInstances.length, 0);
  assert.deepEqual(constructorFailure.urls.revoked, [constructorFailure.urls.created[0].url]);
});
