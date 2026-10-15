'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const home = require('../assets/js/home-workspace.js');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'InternalBeyond.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'assets/js/home-workspace.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/css/home-workspace.css'), 'utf8');
const core = fs.readFileSync(path.join(root, 'assets/js/core.js'), 'utf8');
const primitiveCss = fs.readFileSync(path.join(root, 'assets/css/ui-primitives.css'), 'utf8');
const cssWithoutBom = css.replace(/^\uFEFF/, '');

function pageSection(id, nextId) {
  const start = html.indexOf('id="page-' + id + '"');
  const end = html.indexOf('id="page-' + nextId + '"', start + 1);
  assert(start >= 0 && end > start, 'page section order exists for ' + id);
  return html.slice(start, end);
}

const welcome = pageSection('home', 'workspace');
const dashboard = pageSection('workspace', 'work-mode');
const primitiveImports = Array.from(css.matchAll(/@import\s+url\(["']ui-primitives\.css["']\)/g));

assert(/class="page active" id="page-home"/.test(html), 'the HTML fallback retains narrative Welcome markup before core route bootstrap');
assert(/id="home-subtitle"/.test(welcome) && /id="home-title"/.test(welcome) && /id="home-credit"/.test(welcome),
  'Welcome branding and its existing animation targets remain reachable');
assert(!/workspace-recent-list|Quick Access|Workspace Status/.test(welcome),
  'the narrative Welcome does not contain daily workspace content');

assert(/<div class="page" id="page-workspace">/.test(html), 'Workspace remains a distinct #workspace route');
assert(/class="ib-primitives home-reference" id="workspace-dashboard"/.test(dashboard),
  'production Home opts into the frozen Primitive scope');
assert(/class="ib-page-header"/.test(dashboard) && /class="ib-page-header__title"[^>]*>Continue where you left off/.test(dashboard),
  'Home uses the frozen Page Header for the continuation task');
assert(/class="ib-section home-recent"/.test(dashboard) && /class="ib-section__heading"[^>]*>Recent/.test(dashboard),
  'Recent is grouped by the transparent Section Primitive');
assert(/class="ib-list home-recent-list"/.test(dashboard), 'Recent uses the shared List Primitive');
assert(/class="home-empty-state"[^>]*id="workspace-empty-state"/.test(dashboard), 'the empty message stays a truthful Home state');
assert(/id="workspace-data-notice"[^>]*role="status"[^>]*aria-live="polite"/.test(dashboard),
  'loading and degraded states expose readable polite status text');
assert(/id="workspace-empty-state"[^>]*role="status"[^>]*aria-live="polite"/.test(dashboard),
  'the real empty state is announced and remains content-first');
assert(/#page-workspace \.home-reference \.home-empty-state\s*\{[^}]*color:\s*var\(--ib-token-content-primary\)/.test(css),
  'the empty-state copy uses the semantic foreground needed across the photo backdrop');
assert(/class="btn btn-primary"[^>]*href="#chat"/.test(dashboard),
  'one existing Foundation Control provides the real next action');
assert(!/glass-card|home-quick|Quick Access|Workspace Status|workspace-status-|PERSONAL WORKSPACE|home-workspace-hero/.test(dashboard),
  'Home has no new Card family, duplicated shortcut wall, system-health dashboard or Hero');
assert(!/provider|endpoint|credentialRef|request id|trace|latency|runtime|authority/i.test(dashboard),
  'first-screen Home markup has no technical metadata');
assert(!/workspace-brand-infernal|workspace-brand-light|theme-infernal/.test(dashboard),
  'Internal and Infernal share one Home DOM and one semantic structure');
assert(primitiveImports.length === 1 && !/href="assets\/css\/ui-primitives\.css"/.test(html),
  'production imports Structural Primitives once through the existing Home stylesheet');
assert(/^@import url\("ui-primitives\.css"\);\s*#page-workspace\s*\{/.test(cssWithoutBom),
  'the Primitive import precedes every Home rule so browsers apply it');
assert(/body:not\(\.theme-infernal\):has\(#page-workspace\.active\)\s+#page-overlay:not\(\.show\)\s*\{[\s\S]*display:\s*block;[\s\S]*background:\s*var\(--ib-token-overlay\);[\s\S]*--surface-overlay-filter:\s*none;[\s\S]*animation:\s*none;[\s\S]*transition:\s*none;/.test(css) && !/backdrop-filter\s*:/.test(css),
  'Internal uses the frozen overlay token as a static reading backdrop, without blur or a new Surface');
assert(/href="assets\/css\/home-workspace\.css"/.test(html), 'Home layout CSS has one production link');
assert(!/ui-overlay-primitives\.css|ui-overlay-lifecycle\.js/.test(html),
  'Home does not load unused overlay presentation or runtime');

const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
assert.strictEqual((cssWithoutComments.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length, 0, 'Home CSS adds no raw hex');
assert.strictEqual((cssWithoutComments.match(/rgba?\s*\(/gi) || []).length, 0, 'Home CSS adds no raw rgba or rgb');
assert.strictEqual((cssWithoutComments.match(/--glass-|glass-card/gi) || []).length, 0, 'Home CSS adds no Glass consumer');
assert.strictEqual((cssWithoutComments.match(/(?:border-radius|box-shadow|z-index)\s*:/gi) || []).length, 0,
  'Home CSS invents no radius, shadow or z-index values');
assert.strictEqual((cssWithoutComments.match(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/g) || []).length, 0,
  'Home CSS adds no arbitrary motion duration');
assert(/min-inline-size:\s*0/.test(css) && /@media \(max-width: 640px\)/.test(css),
  'Home layout can shrink and reflow at mobile widths');
assert(/max-width: 768px/.test(css) && /\[hidden\]\s*\{\s*display:\s*none/.test(css),
  'Home clears the existing rail at 768px and keeps hidden live-status markers out of view');
assert(/max-width: 768px[\s\S]*#cal-widget[\s\S]*#wg-petal-field[\s\S]*#game-mini/.test(css),
  'Home yields its existing clock, petals and Room tab where they would cover first-screen content');
assert(/body\.theme-infernal:has\(#page-workspace\.active\)\s+#bg-infernal-img\s*\{\s*filter:\s*brightness\(0\.25\);\s*\}/.test(css),
  'only the high-key Infernal wallpaper is darkened behind Workspace text');
assert(/body:has\(#page-workspace\.active\)\s+#rain-container\s*\{\s*display:\s*none;\s*\}/.test(css),
  'Home hides the existing decorative rain canvas without disabling it on other routes');
assert.strictEqual((css.match(/body\.theme-(?:internal|infernal):/g) || []).length, 1,
  'Home theme-specific styling is limited to its background contrast correction');
assert(/prefers-reduced-motion: reduce[\s\S]*transition: none[\s\S]*animation: none/.test(css),
  'Home explicitly removes its action motion for reduced-motion users');
assert(/min-block-size:\s*44px/.test(primitiveCss) && /prefers-reduced-motion:\s*reduce/.test(primitiveCss),
  'the reused Foundation Control keeps its 44px target and reduced-motion contract');

assert.strictEqual(home.MAX_SCAN_RECORDS, 24, 'recent reads remain bounded');
assert.strictEqual(home.MAX_RECENT_ITEMS, 4, 'the first screen remains a short scan, not an archive');
assert(!/navTo|data-workspace-route/.test(source), 'the Home action stays a native hash link under the existing route owner');

const routeMatch = core.match(/function _ibResolveStartupRoute\(hash,pageExists\)\s*\{[\s\S]*?\n\}/);
assert(routeMatch, 'core owns a small testable Welcome/Home startup decision');
const resolveStartupRoute = vm.runInNewContext(routeMatch[0] + '\n_ibResolveStartupRoute');
const primarySurfaceMatch = core.match(/function _ibIsPrimarySurface\(page\)\s*\{[\s\S]*?\n\}/);
assert(primarySurfaceMatch, 'core classifies Welcome and Workspace as primary surfaces');
const isPrimarySurface = vm.runInNewContext(primarySurfaceMatch[0] + '\n_ibIsPrimarySurface');
assert.strictEqual(isPrimarySurface('home'), true);
assert.strictEqual(isPrimarySurface('workspace'), true, 'Workspace does not inherit subpage overlay treatment');
assert.strictEqual(isPrimarySurface('chat'), false);
assert(/if\(!_ibIsPrimarySurface\(page\)\)/.test(core), 'only non-entry routes activate the subpage overlay');
assert(/if\(page==='home'&&hp\)/.test(core), 'Welcome-only entrance choreography does not run for Workspace');
const pageExists = page => ['home', 'workspace', 'chat'].includes(page);
const route = hash => JSON.parse(JSON.stringify(resolveStartupRoute(hash, pageExists)));
assert.deepStrictEqual(route(''), { page: 'workspace', bypassWelcome: true }, 'no-hash startup opens production Workspace Home');
assert.deepStrictEqual(route('#chat'), { page: 'chat', bypassWelcome: true }, 'deep links retain their requested route');
assert.deepStrictEqual(route('#home'), { page: 'home', bypassWelcome: true }, 'the explicit Welcome narrative route remains reachable');
assert.deepStrictEqual(route('#workspace'), { page: 'workspace', bypassWelcome: true }, 'the Home route remains addressable');
assert(/document\.addEventListener\('DOMContentLoaded',[\s\S]*_ibOpenStartupRoute/.test(core), 'startup routing runs after page modules register');
assert(/setTimeout\(\(\)=>navTo\('workspace'\),2200\)/.test(core), 'the retained Welcome Skip action enters Workspace');
assert(/home\.addEventListener\('click',\(\)=>navTo\('home'\)\)/.test(core), 'the brand control still returns to narrative Welcome');
assert(/id="nav-home"[^>]*aria-label="返回欢迎页"[^>]*data-i18n-aria-label="nav.returnHome"/.test(html), 'Welcome keeps its accessible localized navigation label');
assert(/id="ib-workspace-nav" href="#workspace" data-page="workspace"/.test(html), 'sidebar Home still targets #workspace');

const thread = home.projectThread({
  id: 'private-thread-id', friendId: 'private-role-id', name: 'Planning', created: 1000,
  content: 'must not project', apiKey: 'secret', endpoint: 'https://private.invalid'
});
assert.deepStrictEqual(Object.keys(thread).sort(), ['timestamp', 'title', 'type']);
assert.deepStrictEqual(thread, { title: 'Planning', type: 'Conversation', timestamp: 1000 });

const activity = home.projectActivity({
  id: 'private-activity-id', roleId: 'private-role-id', title: 'Reading session', kind: 'coread',
  updatedAt: 1500, lastActiveAt: 2000, recap: 'private recap', config: { private: true },
  progress: { page: 8 }, endpoint: 'https://private.invalid'
});
assert.deepStrictEqual(Object.keys(activity).sort(), ['timestamp', 'title', 'type']);
assert.deepStrictEqual(activity, { title: 'Reading session', type: 'Reading', timestamp: 2000 });
assert.strictEqual(home.projectThread({ name: '<img src=x>', created: 0 }).title, '<img src=x>');
assert.strictEqual(home.projectActivity({ kind: 'watch', title: 'Film', createdAt: '2026-09-28T00:00:00Z' }).type, 'Cinema');
assert.strictEqual(home.projectActivity({ kind: 'provider-raw', title: 'Session', createdAt: 5 }).type, 'Activity');
assert.strictEqual(home.combineRecent(
  [{ title: 'Old', timestamp: 100, type: 'Conversation' }],
  [{ title: 'New', timestamp: 200, type: 'Reading' }], 1
)[0].title, 'New');
assert.strictEqual(home.formatRelativeTime(0), 'Time unavailable');

function node(className) {
  return {
    className: className || '',
    dataset: {},
    hidden: true,
    textContent: '',
    children: [],
    listeners: {},
    addEventListener(type, callback) { this.listeners[type] = callback; },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    replaceChildren() { this.children = Array.from(arguments); },
    setAttribute(name, value) { this[name] = String(value); },
    contains() { return true; },
    querySelector() { return null; }
  };
}

function makeHarness(options) {
  options = options || {};
  const observerInstances = [];
  let active = false;
  const page = {
    classList: {
      contains(name) { return name === 'active' && active; },
      add(name) { if (name === 'active') active = true; },
      remove(name) { if (name === 'active') active = false; }
    }
  };
  const workspace = node();
  const ids = {
    'page-workspace': page,
    'page-chat': node(),
    'workspace-dashboard': workspace,
    'workspace-recent-list': node(),
    'workspace-empty-state': node(),
    'workspace-data-notice': node(),
    'workspace-data-notice-text': node()
  };
  class FakeObserver {
    constructor(callback) { this.callback = callback; observerInstances.push(this); }
    observe() {}
    disconnect() {}
  }
  const scanned = [];
  const win = {
    MutationObserver: FakeObserver,
    navTo(route) { scanned.push('route:' + route); },
    dbScan: async function (store, visitor, scanOptions) {
      scanned.push(store);
      assert.strictEqual(scanOptions.direction, 'prev');
      assert.strictEqual(scanOptions.maxRecords, 24);
      if (options.failStore === store) throw new Error('private store error');
      const records = store === 'chatThreads' ? (options.threads || []) : (options.activities || []);
      records.forEach(visitor);
      return { count: records.length, stopped: false };
    },
    _ibCount() { throw new Error('Home must not read Memory totals'); },
    IB: { packagingCenter: { createClient() { return { jobs() { throw new Error('Home must not probe Packaging'); } }; } } }
  };
  const document = {
    defaultView: { MutationObserver: FakeObserver },
    getElementById(id) { return ids[id] || null; },
    createElement() { return node(); }
  };
  return {
    page, workspace, ids, document, win, observerInstances, scanned,
    activate() { active = true; observerInstances[0].callback(); },
    deactivate() { active = false; observerInstances[0].callback(); }
  };
}

(async function runHomeChecks() {
  const threadRecord = { id: 'id-1', friendId: 'friend-1', name: 'Planning', created: 1000 };
  const activityRecord = { id: 'id-2', roleId: 'role-2', title: 'Reading session', kind: 'coread', lastActiveAt: 2000 };
  const populated = makeHarness({ threads: [threadRecord], activities: [activityRecord] });
  const mounted = home.mount(populated.document, populated.win);
  assert.deepStrictEqual(populated.scanned, [], 'Welcome boot does not start Home aggregation');
  populated.activate();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepStrictEqual(populated.scanned, ['chatThreads', 'activities'],
    'Home uses only the two bounded real Recent data sources');
  assert.strictEqual(populated.ids['workspace-recent-list'].children.length, 2);
  assert.strictEqual(populated.ids['workspace-recent-list'].children[0].className, 'ib-list-row home-recent-item');
  assert.strictEqual(populated.ids['workspace-recent-list'].children[0].children[0].children[0].textContent, 'Reading session');
  assert.strictEqual(populated.ids['workspace-recent-list'].hidden, false);
  assert.strictEqual(populated.ids['workspace-empty-state'].hidden, true);
  assert.strictEqual(populated.ids['workspace-data-notice'].hidden, true);

  assert.strictEqual(mounted.refresh instanceof Function, true);

  const empty = makeHarness({ threads: [], activities: [] });
  home.mount(empty.document, empty.win);
  empty.activate();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(empty.ids['workspace-empty-state'].hidden, false, 'empty state appears only after both sources are ready');
  assert.strictEqual(empty.ids['workspace-data-notice'].hidden, true);

  const degraded = makeHarness({ threads: [threadRecord], failStore: 'activities' });
  home.mount(degraded.document, degraded.win);
  degraded.activate();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(degraded.ids['workspace-recent-list'].children.length, 1, 'available Recent data remains visible');
  assert.strictEqual(degraded.ids['workspace-data-notice'].hidden, false, 'real partial-data degradation is announced');
  assert.strictEqual(degraded.ids['workspace-data-notice'].dataset.status, 'degraded');
  assert.match(degraded.ids['workspace-data-notice-text'].textContent, /Some recent activity is unavailable/);

  populated.deactivate();
  await new Promise(resolve => setTimeout(resolve, 0));
  const previousScans = populated.scanned.filter(item => item === 'chatThreads' || item === 'activities').length;
  populated.activate();
  await new Promise(resolve => setTimeout(resolve, 0));
  const nextScans = populated.scanned.filter(item => item === 'chatThreads' || item === 'activities').length;
  assert.strictEqual(nextScans, previousScans + 2, 're-entering Home refreshes bounded recent data');
  console.log('Home production adoption, route continuity, recent projections, empty/degraded states, and read boundaries passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
