/* ====================================================================
   P32-W.3 · Secret Route Bridge
   --------------------------------------------------------------------
   One resolver for the existing Browser URL/hash triggers and the Tauri
   Hidden Secret Route Console. This file only normalizes and dispatches;
   the Terminal and Middle Brain Direct Channel remain their own handlers.
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(typeof globalThis !== 'undefined' ? globalThis : global);
  else {
    var api = factory(root);
    root.IB = root.IB || {};
    if (typeof root.IB.expose === 'function') root.IB.expose('secretRoutes', api);
    else root.IB.secretRoutes = api;
  }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var ROUTE_IDS = Object.freeze({ beyond: 'beyond', middlebrain: 'middlebrain' });
  var SOURCES = Object.freeze({ browser: 'browser-url', console: 'tauri-console', keyboard: 'browser-keyboard' });
  var GESTURE_CLICKS = 7;
  var GESTURE_WINDOW_MS = 1800;
  var CONSOLE_ALIASES = Object.freeze({
    beyond: ROUTE_IDS.beyond,
    '#beyond': ROUTE_IDS.beyond,
    middlebrain: ROUTE_IDS.middlebrain,
    '?middlebrain': ROUTE_IDS.middlebrain,
    '?middlebrain=1': ROUTE_IDS.middlebrain,
    '?middlebrain=true': ROUTE_IDS.middlebrain
  });
  var _browserDirectActive = false;
  var _gestureCount = 0;
  var _gestureStartedAt = 0;
  var _console = null;
  var _booted = false;

  function text(value, max) {
    var out = value == null ? '' : String(value);
    return max && out.length > max ? out.slice(0, max) : out;
  }

  function sourceOf(context, fallback) {
    var source = context && context.source;
    return source === SOURCES.browser || source === SOURCES.console || source === SOURCES.keyboard ? source : fallback;
  }

  function noMatch(source, normalizedInput) {
    return {
      matched: false,
      routeId: null,
      normalizedInput: normalizedInput || null,
      source: source || null,
      action: null
    };
  }

  function match(routeId, source) {
    return {
      matched: true,
      routeId: routeId,
      normalizedInput: routeId,
      source: source,
      action: routeId === ROUTE_IDS.beyond ? 'open-beyond-terminal' : 'open-middlebrain-direct'
    };
  }

  function directQuery(search) {
    search = text(search);
    try {
      var params = new URLSearchParams(search);
      if (!params.has('middlebrain')) return false;
      var value = params.get('middlebrain');
      return value === '' || value === '1' || value === 'true';
    } catch (e) {
      var query = search.replace(/^\?/, '');
      var matchValue = query.match(/(?:^|&)middlebrain(?:=([^&]*))?(?:&|$)/);
      if (!matchValue) return false;
      var fallbackValue = matchValue[1] == null ? '' : matchValue[1];
      return fallbackValue === '' || fallbackValue === '1' || fallbackValue === 'true';
    }
  }

  function beyondHash(hash) {
    /* Keep the legacy Terminal semantics: its existing handler tests the
       complete hash string with /beyond/i, including its historical broad
       substring match. The console remains exact-allowlist-only below. */
    return /beyond/i.test(text(hash));
  }

  function browserMatches(locationLike) {
    var location = locationLike || (root && root.location) || {};
    var out = [];
    if (directQuery(location.search)) out.push(match(ROUTE_IDS.middlebrain, SOURCES.browser));
    if (beyondHash(location.hash)) out.push(match(ROUTE_IDS.beyond, SOURCES.browser));
    return out;
  }

  function consoleMatch(value) {
    var raw = text(value).trim();
    if (!raw || raw.length > 128) return noMatch(SOURCES.console, null);
    var routeId = CONSOLE_ALIASES[raw.toLowerCase()];
    return routeId ? match(routeId, SOURCES.console) : noMatch(SOURCES.console, null);
  }

  function resolve(input, context) {
    context = context || {};
    var source = sourceOf(context, null);
    if (!source && input && typeof input === 'object' && (input.location || input.search !== undefined || input.hash !== undefined)) source = SOURCES.browser;
    if (source === SOURCES.browser) {
      var location = input && typeof input === 'object' && input.location ? input.location : input;
      var routes = browserMatches(location);
      return routes.length ? routes[0] : noMatch(SOURCES.browser, null);
    }
    if (source === SOURCES.console) {
      var command = input && typeof input === 'object' ? (input.command !== undefined ? input.command : input.value) : input;
      return consoleMatch(command);
    }
    return noMatch(null, null);
  }

  function tauriSurface() {
    try {
      var host = root && root.IB && root.IB.host;
      return !!(host && typeof host.platform === 'function' && host.platform() === 'tauri');
    } catch (e) { return false; }
  }

  function safeDispatchOptions(options) {
    options = options || {};
    var source = sourceOf(options, null);
    var out = { triggerSource: source || null };
    ['previousPage', 'previousHash', 'previousQuery'].forEach(function (key) {
      if (typeof options[key] === 'string' && options[key].length <= 256) out[key] = options[key];
    });
    return out;
  }

  function dispatch(routeId, options) {
    var safe = safeDispatchOptions(options);
    var source = safe.triggerSource || SOURCES.console;
    if (routeId !== ROUTE_IDS.beyond && routeId !== ROUTE_IDS.middlebrain) {
      return Object.assign(noMatch(source, null), { error: 'unknown-route' });
    }
    try {
      var ib = root && root.IB;
      if (routeId === ROUTE_IDS.beyond) {
        var egg = ib && ib.easterEgg;
        if (!egg || typeof egg.open !== 'function') return Object.assign(match(routeId, source), { dispatched: false, error: 'handler-unavailable' });
        egg.open();
      } else {
        var direct = ib && ib.middleBrainDirect;
        if (!direct || typeof direct.mount !== 'function') return Object.assign(match(routeId, source), { dispatched: false, error: 'handler-unavailable' });
        var mountOptions = { force: source === SOURCES.console, triggerSource: safe.triggerSource };
        direct.mount(mountOptions);
      }
      return Object.assign(match(routeId, source), { dispatched: true });
    } catch (e) {
      return Object.assign(match(routeId, source), { dispatched: false, error: 'handler-failed' });
    }
  }

  function closeDirectIfActive() {
    if (!_browserDirectActive) return;
    try {
      var direct = root && root.IB && root.IB.middleBrainDirect;
      if (direct && typeof direct.close === 'function') direct.close();
    } catch (e) {}
    _browserDirectActive = false;
  }

  function handleBrowser(locationLike) {
    var location = locationLike || (root && root.location) || {};
    var routes = browserMatches(location);
    var directRoute = null;
    var first = routes.length ? routes[0] : noMatch(SOURCES.browser, null);
    routes.forEach(function (route) {
      if (route.routeId === ROUTE_IDS.middlebrain) directRoute = route;
    });
    if (directRoute) {
      var directResult = dispatch(directRoute.routeId, { source: SOURCES.browser });
      _browserDirectActive = directResult.dispatched === true;
      first = directResult;
    } else closeDirectIfActive();
    routes.forEach(function (route) {
      if (route.routeId === ROUTE_IDS.beyond) {
        var beyondResult = dispatch(route.routeId, { source: SOURCES.browser });
        if (!first.matched) first = beyondResult;
      }
    });
    return first;
  }

  function consoleElement(tag, className, value) {
    var node = root.document.createElement(tag);
    if (className) node.className = className;
    if (value != null) node.textContent = value;
    return node;
  }

  function closeConsole(restoreFocus) {
    if (!_console) return false;
    _console.open = false;
    _console.wrap.hidden = true;
    _console.wrap.setAttribute('aria-hidden', 'true');
    _console.wrap.classList.remove('is-open');
    if (restoreFocus !== false && _console.trigger && typeof _console.trigger.focus === 'function') {
      try { _console.trigger.focus(); } catch (e) {}
    }
    return true;
  }

  function submitConsole() {
    if (!_console) return;
    var result = resolve({ command: _console.input.value }, { source: SOURCES.console });
    if (!result.matched) {
      _console.status.textContent = 'Unknown secret route.';
      _console.input.focus();
      return;
    }
    var trigger = _console.trigger;
    closeConsole(false);
    var dispatched = dispatch(result.routeId, { source: SOURCES.console });
    if (!dispatched.dispatched) {
      openConsole(trigger);
      _console.status.textContent = 'Secret route unavailable.';
    }
  }

  function ensureConsole() {
    if (_console && _console.wrap && _console.wrap.isConnected) return _console;
    if (!root.document || !root.document.body) return null;
    var wrap = consoleElement('div', 'ib-secret-route-console');
    wrap.id = 'ib-secret-route-console';
    wrap.hidden = true;
    wrap.setAttribute('aria-hidden', 'true');
    var backdrop = consoleElement('div', 'ib-secret-route-backdrop');
    var panel = consoleElement('section', 'ib-secret-route-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'ib-secret-route-title');
    var head = consoleElement('header', 'ib-secret-route-head');
    var heading = consoleElement('div', 'ib-secret-route-heading');
    heading.appendChild(consoleElement('strong', '', 'InternalBeyond'));
    heading.appendChild(consoleElement('span', '', 'Secret Route'));
    var close = consoleElement('button', 'ib-secret-route-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭 Secret Route Console');
    head.appendChild(heading);
    head.appendChild(close);
    var title = consoleElement('h2', '', 'Secret Route');
    title.id = 'ib-secret-route-title';
    var hint = consoleElement('p', 'ib-secret-route-hint', '输入已知的 secret route alias。这里不是 URL 或 shell。');
    var form = consoleElement('form', 'ib-secret-route-form');
    var prefix = consoleElement('span', 'ib-secret-route-prefix', 'internalbeyond://');
    var input = consoleElement('input', 'ib-secret-route-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Beyond / middlebrain';
    input.setAttribute('aria-label', 'Secret route alias');
    var submit = consoleElement('button', 'ib-secret-route-submit', 'Open');
    submit.type = 'submit';
    form.appendChild(prefix);
    form.appendChild(input);
    form.appendChild(submit);
    var status = consoleElement('p', 'ib-secret-route-status', '');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    panel.appendChild(head);
    panel.appendChild(title);
    panel.appendChild(hint);
    panel.appendChild(form);
    panel.appendChild(status);
    wrap.appendChild(backdrop);
    wrap.appendChild(panel);
    root.document.body.appendChild(wrap);
    close.addEventListener('click', function () { closeConsole(true); });
    backdrop.addEventListener('click', function () { closeConsole(true); });
    panel.addEventListener('click', function (event) { event.stopPropagation(); });
    form.addEventListener('submit', function (event) { event.preventDefault(); submitConsole(); });
    _console = { wrap: wrap, input: input, status: status, trigger: null, open: false };
    return _console;
  }

  function openConsole(trigger) {
    if (!tauriSurface()) return false;
    var ui = ensureConsole();
    if (!ui) return false;
    ui.trigger = trigger || ui.trigger || root.document.activeElement;
    ui.open = true;
    ui.wrap.hidden = false;
    ui.wrap.setAttribute('aria-hidden', 'false');
    ui.wrap.classList.add('is-open');
    ui.status.textContent = '';
    ui.input.value = '';
    ui.input.focus();
    return true;
  }

  function resetGesture() {
    _gestureCount = 0;
    _gestureStartedAt = 0;
  }

  function onGesture(event) {
    var now = Date.now();
    if (!_gestureStartedAt || now - _gestureStartedAt > GESTURE_WINDOW_MS) {
      _gestureStartedAt = now;
      _gestureCount = 0;
    }
    _gestureCount++;
    if (_gestureCount >= GESTURE_CLICKS) {
      resetGesture();
      openConsole(event && event.currentTarget);
    }
  }

  function installGesture() {
    if (!tauriSurface() || !root.document) return;
    var trigger = root.document.getElementById('nav-home');
    if (!trigger || trigger.__ibSecretGestureBound) return;
    trigger.__ibSecretGestureBound = true;
    trigger.addEventListener('click', onGesture);
    root.addEventListener('hashchange', resetGesture);
  }

  function onKeydown(event) {
    if (_console && _console.open && event.key === 'Escape') {
      event.preventDefault();
      closeConsole(true);
    }
  }

  function boot() {
    if (_booted || !root.document) return;
    _booted = true;
    root.addEventListener('hashchange', function () { handleBrowser(); });
    root.addEventListener('popstate', function () { handleBrowser(); });
    root.document.addEventListener('keydown', onKeydown);
    handleBrowser();
    installGesture();
  }

  var api = {
    routeIds: ROUTE_IDS,
    sources: SOURCES,
    resolve: resolve,
    dispatch: dispatch,
    handleBrowser: handleBrowser,
    openConsole: openConsole,
    closeConsole: closeConsole,
    isConsoleOpen: function () { return !!(_console && _console.open); },
    gesture: { clicks: GESTURE_CLICKS, windowMs: GESTURE_WINDOW_MS }
  };

  if (root && root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot);
    else setTimeout(boot, 0);
  }
  return api;
});
