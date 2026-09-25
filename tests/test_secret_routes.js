/* P32-W.3 · Secret Route Resolver contract.
   Pure Node: route normalization and dispatch identity only; no browser,
   network, model, storage, filesystem, or native host call. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let beyondCalls = 0;
const directCalls = [];
globalThis.IB = {
  easterEgg: { open: () => { beyondCalls++; } },
  middleBrainDirect: { mount: options => { directCalls.push(options || {}); } }
};
const routes = require(path.join(__dirname, '..', 'assets', 'js', 'secret-routes.js'));

function check(name, condition, detail) {
  if (!condition) throw new Error(name + (detail ? ': ' + detail : ''));
  console.log('✓ ' + name);
}

function main() {
  const consoleAliases = ['Beyond', 'beyond', '#Beyond', 'middlebrain', '?middlebrain', '?middlebrain=1', '?middlebrain=true'];
  for (const input of consoleAliases) {
    const result = routes.resolve(input, { source: routes.sources.console });
    check('resolve.console.' + input, result.matched === true && (result.routeId === 'beyond' || result.routeId === 'middlebrain'), JSON.stringify(result));
  }
  check('resolve.browser.middlebrain', routes.resolve({ search: '?middlebrain', hash: '#chat' }, { source: routes.sources.browser }).routeId === 'middlebrain');
  check('resolve.browser.middlebrain-1', routes.resolve({ search: '?middlebrain=1', hash: '#chat' }, { source: routes.sources.browser }).routeId === 'middlebrain');
  check('resolve.browser.middlebrain-true', routes.resolve({ search: '?middlebrain=true', hash: '#chat' }, { source: routes.sources.browser }).routeId === 'middlebrain');
  check('resolve.browser.beyond', routes.resolve({ search: '', hash: '#Beyond' }, { source: routes.sources.browser }).routeId === 'beyond');
  check('resolve.browser.false-query', routes.resolve({ search: '?middlebrain=0', hash: '#chat' }, { source: routes.sources.browser }).matched === false);
  check('resolve.browser.unknown-hash', routes.resolve({ search: '', hash: '#unknown' }, { source: routes.sources.browser }).matched === false);

  const beforeResolve = { beyond: beyondCalls, direct: directCalls.length };
  const dangerous = [
    'javascript:alert(1)', 'file:///C:/Windows/System32', 'https://example.com',
    'http://127.0.0.1', 'cmd.exe', 'powershell', '../../runtime', '..\\..\\',
    'C:\\Windows', 'internalbeyond://../../foo', '<svg onload=...>', '<script>...</script>', 'midlebran'
  ];
  for (const input of dangerous) {
    const result = routes.resolve(input, { source: routes.sources.console });
    check('reject.' + input, result.matched === false && result.routeId === null, JSON.stringify(result));
  }
  check('resolve.zero-handler-side-effects', beyondCalls === beforeResolve.beyond && directCalls.length === beforeResolve.direct);

  const beyond = routes.dispatch('beyond', { source: routes.sources.console });
  check('dispatch.beyond-existing-handler', beyond.dispatched === true && beyondCalls === 1);
  const direct = routes.dispatch('middlebrain', { source: routes.sources.console });
  check('dispatch.middlebrain-existing-handler', direct.dispatched === true && directCalls.length === 1 && directCalls[0].force === true);
  const browserDirect = routes.dispatch('middlebrain', { source: routes.sources.browser });
  check('dispatch.browser-preserves-handler', browserDirect.dispatched === true && directCalls.length === 2 && directCalls[1].force === false);
  const unknown = routes.dispatch('javascript:alert(1)', { source: routes.sources.console });
  check('dispatch.unknown-no-handler', unknown.matched === false && beyondCalls === 1 && directCalls.length === 2);

  const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'secret-routes.js'), 'utf8');
  for (const forbidden of [/\beval\s*\(/, /\bfetch\s*\(/, /XMLHttpRequest/, /localStorage/, /indexedDB/, /__TAURI__/, /child_process/, /\b(?:exec|spawn|invoke)\s*\(/]) {
    check('resolver.no-' + forbidden.source, !forbidden.test(source));
  }
  console.log('P32-W.3 Secret Route Resolver: all checks passed');
}

main();
