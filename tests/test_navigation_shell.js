'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const navigation = require('../assets/js/navigation-shell.js');
const secretRoutes = require('../assets/js/secret-routes.js');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'InternalBeyond.html'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'assets/js/core.js'), 'utf8');
const gameModule = fs.readFileSync(path.join(ROOT, 'game/game_module.js'), 'utf8');
const chrome = fs.readFileSync(path.join(ROOT, 'assets/js/tauri-window-chrome.js'), 'utf8');
const tauri = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'));

function navGroups(source) {
  const start = source.indexOf('<ul class="nav-links"');
  const end = source.indexOf('</ul>', start);
  assert.ok(start >= 0 && end > start, 'workspace navigation list exists');
  const body = source.slice(start, end);
  const rows = Array.from(body.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/g));
  const groups = [];
  let current = null;
  for (const row of rows) {
    const attrs = row[1], content = row[2];
    if (/\bnav-group-label\b/.test(attrs)) {
      current = { label: content.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim(), routes: [] };
      groups.push(current);
      continue;
    }
    const link = content.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const page = (link[1].match(/\bdata-page="([^"]+)"/) || [])[1];
    const label = (link[2].match(/class="nav-label"[^>]*>([^<]*)/) || [])[1];
    if (page) current.routes.push({ page: page, label: label || '' });
  }
  return groups;
}

const groups = navGroups(html);
assert.deepStrictEqual(groups.map(group => group.label), ['Core', 'Create & Connect', 'Work', 'Tools', 'Help']);
assert.deepStrictEqual(groups.map(group => group.routes.map(route => route.page)), [
  ['workspace', 'chat', 'voicebox', 'about', 'memory', 'favorites'],
  ['blog', 'moments', 'letters', 'roledm', 'diary'],
  ['active', 'diy', 'work-mode', 'apps', 'economy'],
  ['packaging', 'settings', 'api', 'diagnostics'],
  ['guide']
]);

const visibleRoutes = groups.flatMap(group => group.routes);
assert.strictEqual(new Set(visibleRoutes.map(route => route.page)).size, visibleRoutes.length, 'visible routes are unique');
const pageIds = new Set(Array.from(html.matchAll(/id="page-([^"]+)"/g), match => match[1]));
for (const route of visibleRoutes) {
  assert.ok(pageIds.has(route.page), 'sidebar route has its original page id: ' + route.page);
}

/* Desktop cornice keeps ten primary places; every contextual route keeps its
   page container, hash, navTo access and its sidebar entry below 769px. */
const navLinksStart = html.indexOf('<ul class="nav-links"');
const navLinksBlock = html.slice(navLinksStart, html.indexOf('</ul>', navLinksStart));
assert.ok(!navLinksBlock.includes('ib-bridge-nav'), 'Bridge leaves the place list in nav-links');
const navActionsStart = html.indexOf('<div class="nav-actions">');
assert.ok(navActionsStart > navLinksStart && html.indexOf('id="ib-bridge-nav"') > navActionsStart,
  'Bridge lives in the existing nav-actions region as a dialog action');
assert.ok(/id="ib-bridge-nav"[^>]*aria-haspopup="dialog"[^>]*aria-controls="ib-bridge-panel"[^>]*aria-expanded="false"/.test(html),
  'Bridge keeps its dialog action contract');
assert.ok(!pageIds.has('bridge'), 'Bridge remains a modal action, not a route');

const DESKTOP_PERMANENT = ['settings', 'about', 'blog', 'moments', 'game', 'chat', 'letters', 'memory', 'api', 'diy'];
assert.deepStrictEqual(navigation.DESKTOP_ROUTE_ORDER, DESKTOP_PERMANENT,
  'desktop cornice order keeps only the ten primary places');

const contextual = ['voicebox', 'favorites', 'roledm', 'diary', 'active', 'work-mode', 'apps', 'economy', 'packaging', 'guide', 'diagnostics'];
for (const page of contextual) {
  assert.ok(new RegExp('<li class="nav-item-contextual"><a href="#' + page + '" data-page="' + page + '"').test(html),
    page + ' keeps its sidebar entry but leaves the permanent desktop cornice');
}
for (const page of ['workspace', 'chat', 'about', 'memory', 'blog', 'moments', 'letters', 'diy', 'settings', 'api']) {
  assert.ok(!new RegExp('<li class="nav-item-contextual"><a[^>]*data-page="' + page + '"').test(html),
    page + ' does not carry the contextual marker');
}

const navCss = fs.readFileSync(path.join(ROOT, 'assets/css/navigation-shell.css'), 'utf8');
assert.ok(navCss.includes('@media(min-width:769px)'), 'desktop cornice media block remains');
assert.ok(navCss.includes('.nav-links>li.nav-item-contextual{display:none}'),
  'contextual entries are hidden only at desktop widths');

/* Owner entries for the real reachability gaps: one text-level link per owner page. */
assert.ok(/<button[^>]*id="chat-roledm-link"[^>]*navTo\('roledm'\)/.test(html), 'Chat hosts the Role DM owner entry');
assert.ok(/<button[^>]*id="mem-favorites-link"[^>]*navTo\('favorites'\)/.test(html), 'Memory hosts the Favorites owner entry');
assert.ok(core.includes('id="profile-moments-link"') && core.includes("navTo(\\'moments\\')"), 'Profile hosts the low-weight Moments owner entry');
assert.ok(fs.readFileSync(path.join(ROOT, 'assets/css/core.css'), 'utf8').includes('.u-context-link{'),
  'owner entries share one text-level style');

assert.ok(html.includes('id="nav-home"'), 'the original home trigger and secret gesture target remain');
assert.ok(pageIds.has('home'));
assert.ok(pageIds.has('workspace'), 'the P37 Home Workspace is a distinct route from the legacy Welcome page');
assert.ok(/id="ib-workspace-nav" href="#workspace" data-page="workspace"/.test(html), 'Sidebar Home opens the P37 workspace route');
assert.ok(pageIds.has('moments-settings'), 'nested Moments settings route remains');
assert.ok(pageIds.has('coread'), 'Coread route remains even though it is not a top-level item');
assert.ok(/data-page="game"/.test(gameModule) && /page\.id='page-game'/.test(gameModule), 'the existing Room route remains dynamically supplied by its module');
assert.ok(/normalizeNavigationLinks/.test(fs.readFileSync(path.join(ROOT, 'assets/js/navigation-shell.js'), 'utf8')),
  'dynamically injected route links receive the same collapsed/expanded presentation');
assert.ok(!visibleRoutes.some(route => ['characters', 'middlebrain', 'cinema', 'voice', 'calendar'].includes(route.page)),
  'embedded and hidden capabilities do not become invented routes');
assert.ok(/function navTo\(page\)/.test(core));
assert.ok(/document\.getElementById\('page-'\+page\)/.test(core));
assert.ok(/window\.addEventListener\('hashchange'/.test(core));
assert.strictEqual(secretRoutes.resolve({ search: '', hash: '#Beyond' }, { source: secretRoutes.sources.browser }).routeId, 'beyond');
assert.strictEqual(secretRoutes.resolve({ search: '?middlebrain', hash: '#chat' }, { source: secretRoutes.sources.browser }).routeId, 'middlebrain');
assert.strictEqual(secretRoutes.resolve({ search: '?middlebrain=0', hash: '#chat' }, { source: secretRoutes.sources.browser }).matched, false);

assert.strictEqual(tauri.app.windows[0].url, 'InternalBeyond.html?ib_tauri_host=1', 'Tauri keeps the existing page/query route');
assert.ok(chrome.includes('appWindow.startDragging()'));
assert.ok(chrome.includes('appWindow.minimize()'));
assert.ok(chrome.includes('appWindow.toggleMaximize()'));
assert.ok(chrome.includes('appWindow.close()'));

const memory = new Map();
const storage = {
  getItem: key => memory.has(key) ? memory.get(key) : null,
  setItem: (key, value) => memory.set(key, value)
};
assert.strictEqual(navigation.COLLAPSED_KEY, 'ib_navigation_collapsed_v1');
assert.strictEqual(navigation.defaultCollapsed(1440), false);
assert.strictEqual(navigation.defaultCollapsed(1024), true);
assert.strictEqual(navigation.initialCollapsed(storage, 1440), false);
storage.setItem(navigation.COLLAPSED_KEY, '1');
assert.strictEqual(navigation.initialCollapsed(storage, 1440), true);
storage.setItem(navigation.COLLAPSED_KEY, '0');
assert.strictEqual(navigation.initialCollapsed(storage, 1024), false);

console.log('PASS test_navigation_shell');
