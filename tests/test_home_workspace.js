'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const home = require('../assets/js/home-workspace.js');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'InternalBeyond.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'assets/js/home-workspace.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/css/home-workspace.css'), 'utf8');
const core = fs.readFileSync(path.join(root, 'assets/js/core.js'), 'utf8');

function pageSection(id, nextId) {
  const start = html.indexOf('id="page-' + id + '"');
  const end = html.indexOf('id="page-' + nextId + '"', start + 1);
  assert(start >= 0 && end > start, 'page section order exists for ' + id);
  return html.slice(start, end);
}

const welcome = pageSection('home', 'workspace');
const dashboard = pageSection('workspace', 'blog');

assert(/class="page active" id="page-home"/.test(html), 'the default Welcome/Landing route remains #page-home');
assert(/id="home-subtitle"/.test(welcome) && /id="home-title"/.test(welcome) && /id="home-credit"/.test(welcome),
  'the original Welcome branding nodes and animation IDs are restored');
assert(!/Personal Workspace|id="workspace-recent-list"|Quick Access|Workspace Status|workspace-status-storage/.test(welcome),
  'Welcome must not contain P37 Dashboard content');

assert(/<div class="page" id="page-workspace">/.test(html), 'P37 has a distinct Home Workspace route');
for (const marker of ['PERSONAL WORKSPACE', 'id="workspace-recent-list"', 'Quick Access', 'Workspace Status', 'workspace-status-storage', 'workspace-status-memory', 'workspace-status-packaging', 'workspace-status-voice']) {
  assert(dashboard.includes(marker), 'Home Workspace must contain ' + marker);
}
assert(dashboard.includes('workspace-brand-light') && dashboard.includes('workspace-brand-infernal'), 'the relocated brand treatment retains both theme variants');
assert(/id="nav-home"/.test(html), 'the legacy Welcome brand entry and secret gesture target remain');
assert(/id="nav-home"[^>]*aria-label="返回 Welcome \/ Landing"/.test(html), 'the legacy brand entry names its Welcome/Landing destination');
assert(/id="ib-workspace-nav" href="#workspace" data-page="workspace"/.test(html), 'Sidebar Home targets the workspace route');
assert(/home\.addEventListener\('click',\(\)=>navTo\('home'\)\)/.test(core), '#nav-home retains its existing Welcome route semantics');
assert(/let currentPage='home'/.test(core), 'startup still opens the Welcome route');
assert(/const active=a\.dataset\.page===page/.test(core), 'active styling follows the actual navTo route');
assert(/href="assets\/css\/home-workspace\.css"/.test(html), 'Home workspace stylesheet remains linked');
assert(/src="assets\/js\/home-workspace\.js"/.test(html), 'Home workspace controller remains linked');
assert(/#page-workspace/.test(css) && !/#page-home/.test(css), 'Dashboard styles are scoped to the workspace page');
assert(/body\.theme-infernal #page-workspace \.workspace-brand-infernal/.test(css), 'the relocated brand variant follows the existing dark theme class');
assert(!/^\s*\.home-/m.test(css), 'Dashboard selectors are not global home selectors');

const quickRoutes = Array.from(dashboard.matchAll(/data-workspace-route="([a-z-]+)"/g), match => match[1]);
assert(quickRoutes.length >= 7, 'Home must provide its workspace shortcuts');
for (const route of quickRoutes) {
  assert(Object.prototype.hasOwnProperty.call(home.ROUTES, route), 'Shortcut must use an approved route: ' + route);
  assert(new RegExp('id="page-' + route + '"').test(html), 'Shortcut target must be an existing page: ' + route);
}
assert(/win\.navTo\(route\)/.test(source), 'Shortcuts must use the existing navTo router');

assert(/scanProjection\(win, 'chatThreads', projectThread\)/.test(source), 'Recent conversations must use bounded thread metadata');
assert(/scanProjection\(win, 'activities', projectActivity\)/.test(source), 'Recent activities must use bounded Activity metadata');
assert(/maxRecords: MAX_SCAN_RECORDS/.test(source), 'Recent scans must be bounded');
assert(/_ibCount\('memories'\)/.test(source), 'Memory status must use count-only access');
assert(/center\.createClient\(\)\.jobs\(\)/.test(source), 'Packaging status must use the existing read endpoint');
assert(/result\.available/.test(source), 'Packaging status may read the availability flag');
assert(!/result\.jobs/.test(source), 'Home must discard Packaging job details');
assert(/<strong>Voice<\/strong><small class="workspace-status-value">Open Chat to use Voice<\/small>/.test(dashboard), 'Voice must be presented as a Chat location, not a probed availability claim');
assert(/\.textContent\s*=/.test(source), 'Dynamic status and greeting text must use textContent');
assert(!/\.innerHTML|insertAdjacentHTML|dbGetAll|chatMessages|chatSummaries|updateMemDashboard|sendChatMessage|apiKey|credential|vault|preflight|createPackagingJob|dbPut\s*\(|dbDelete\s*\(/i.test(source), 'Home must not access content, secrets, execution, or write paths');

const thread = home.projectThread({ id: 'unretained-id', friendId: 'unretained-role', name: 'Planning', created: 1000, memoryEnabled: true });
assert.deepStrictEqual(Object.keys(thread).sort(), ['timestamp', 'title', 'type']);
assert.deepStrictEqual(thread, { title: 'Planning', type: 'Conversation', timestamp: 1000 });

const activity = home.projectActivity({
  id: 'unretained-id', title: 'Reading session', kind: 'coread', updatedAt: 2000,
  recap: 'private recap', config: { private: true }, progress: { page: 8 }
});
assert.deepStrictEqual(Object.keys(activity).sort(), ['timestamp', 'title', 'type']);
assert.deepStrictEqual(activity, { title: 'Reading session', type: 'Reading', timestamp: 2000 });
assert.strictEqual(home.projectThread({ name: '<img src=x>', created: 0 }).title, '<img src=x>');
assert.strictEqual(home.projectActivity({ kind: 'watch', createdAt: '2026-09-28T00:00:00Z' }).type, 'Cinema');
assert.strictEqual(home.combineRecent([thread], [activity], 1)[0].title, 'Reading session');
assert.strictEqual(home.formatRelativeTime(0), 'Time unavailable');
assert.strictEqual(home.greetingFor(8), 'Good morning');

function makeLifecycleHarness() {
  const observerInstances = [];
  let active = false;
  function node() {
    return {
      dataset: {}, hidden: true, textContent: '', className: '', children: [], listeners: {},
      addEventListener: function (type, callback) { this.listeners[type] = callback; },
      appendChild: function (child) { this.children.push(child); },
      replaceChildren: function () { this.children = Array.from(arguments); },
      setAttribute: function () {},
      contains: function () { return true; },
      querySelector: function () { return this.statusValue || null; }
    };
  }
  const page = { classList: {
    contains: function (name) { return name === 'active' && active; },
    add: function (name) { if (name === 'active') active = true; },
    remove: function (name) { if (name === 'active') active = false; }
  } };
  const ids = {
    'page-workspace': page,
    'workspace-dashboard': node(),
    'workspace-recent-list': node(),
    'workspace-empty-state': node(),
    'workspace-data-notice': node(),
    'workspace-greeting': node(),
    'workspace-status-storage': node(),
    'workspace-status-memory': node(),
    'workspace-status-packaging': node()
  };
  for (const id of ['workspace-status-storage', 'workspace-status-memory', 'workspace-status-packaging']) {
    ids[id].statusValue = node();
  }
  class FakeObserver {
    constructor(callback) { this.callback = callback; observerInstances.push(this); }
    observe() {}
    disconnect() {}
  }
  let scanCalls = 0, memoryCalls = 0, packagingCalls = 0;
  const document = {
    defaultView: { MutationObserver: FakeObserver },
    getElementById: function (id) { return ids[id] || null; },
    createElement: function () { return node(); }
  };
  const win = {
    MutationObserver: FakeObserver,
    dbScan: async function () { scanCalls++; return { count: 0, stopped: false }; },
    _ibCount: async function () { memoryCalls++; return 0; },
    IB: { packagingCenter: { createClient: function () { return { jobs: async function () {
      packagingCalls++;
      return { ok: true, available: true };
    } }; } } },
    navTo: function () {}
  };
  return {
    page: page,
    document: document,
    win: win,
    observer: observerInstances,
    get calls() { return { scanCalls, memoryCalls, packagingCalls }; }
  };
}

(async function runReadBoundaryChecks() {
  const lifecycle = makeLifecycleHarness();
  home.mount(lifecycle.document, lifecycle.win);
  assert.deepStrictEqual(lifecycle.calls, { scanCalls: 0, memoryCalls: 0, packagingCalls: 0 },
    'Welcome boot must not start Home aggregation');
  lifecycle.page.classList.add('active');
  lifecycle.observer[0].callback();
  assert.deepStrictEqual(lifecycle.calls, { scanCalls: 2, memoryCalls: 1, packagingCalls: 1 },
    'Home entry starts its four existing bounded/read-only data sources');
  await new Promise(resolve => setTimeout(resolve, 0));
  lifecycle.page.classList.remove('active');
  lifecycle.observer[0].callback();
  assert.deepStrictEqual(lifecycle.calls, { scanCalls: 2, memoryCalls: 1, packagingCalls: 1 },
    'Leaving Home does not start another aggregation');
  lifecycle.page.classList.add('active');
  lifecycle.observer[0].callback();
  assert.deepStrictEqual(lifecycle.calls, { scanCalls: 4, memoryCalls: 2, packagingCalls: 2 },
    'Re-entering Home refreshes its read-only workspace snapshot');

  const visited = [];
  const scanWin = {
    dbScan: async function (store, visitor, options) {
      visited.push(store, options.direction, options.maxRecords);
      visitor({ id: 'private', name: 'Only title', created: 3000, message: 'must not project' });
      return { count: 1, stopped: false };
    }
  };
  const projected = await home.scanProjection(scanWin, 'chatThreads', home.projectThread);
  assert.deepStrictEqual(visited, ['chatThreads', 'prev', 24]);
  assert.deepStrictEqual(projected, [{ title: 'Only title', type: 'Conversation', timestamp: 3000 }]);

  const availability = await home.readPackagingAvailability({
    IB: { packagingCenter: { createClient: function () { return { jobs: async function () {
      const result = { ok: true, available: true };
      Object.defineProperty(result, 'jobs', { get: function () { throw new Error('job details must be ignored'); } });
      return result;
    } }; } } }
  });
  assert.strictEqual(availability, true);

  const count = await home.readMemoryCount({ _ibCount: async store => store === 'memories' ? 3 : -1 });
  assert.strictEqual(count, 3);
  console.log('Welcome/Home ownership, lazy loading, projections, and read boundaries passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
