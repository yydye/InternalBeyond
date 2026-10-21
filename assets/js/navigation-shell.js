'use strict';

/* P36 · Shell presentation state only. Route dispatch remains in core.js. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root.IB = root.IB || {};
  root.IB.navigationShell = api;
  api.mount(root.document, root);
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const COLLAPSED_KEY = 'ib_navigation_collapsed_v1';
  const COLLAPSE_BREAKPOINT = 1120;
  const DESKTOP_TOPBAR_BREAKPOINT = 769;
  /* Phase 2 · Navigation Exposure Reconciliation: the permanent desktop cornice holds
     only the ten primary places. The narrow sidebar (<769px) keeps the full grouped
     inventory; routes not listed here keep their pages, hashes and programmatic access. */
  const DESKTOP_ROUTE_ORDER = Object.freeze([
    'settings', 'about', 'blog', 'map', 'moments', 'game', 'chat', 'letters', 'memory', 'api', 'diy'
  ]);

  function storedCollapsed(storage) {
    try {
      const value = storage && storage.getItem(COLLAPSED_KEY);
      if (value === '1') return true;
      if (value === '0') return false;
    } catch (_) { }
    return null;
  }

  function defaultCollapsed(width) {
    return Number(width) <= COLLAPSE_BREAKPOINT;
  }

  function initialCollapsed(storage, width) {
    const saved = storedCollapsed(storage);
    return saved === null ? defaultCollapsed(width) : saved;
  }

  function browserStorage(win) {
    try { return win && win.localStorage; } catch (_) { return null; }
  }

  function normalizeNavigationLinks(nav, document) {
    if (!nav || !document) return;
    nav.querySelectorAll('.nav-links a[data-page]').forEach(function (link) {
      if (link.querySelector('.nav-glyph') && link.querySelector('.nav-label')) return;
      const label = String(link.textContent || '').trim();
      if (!label) return;
      const glyph = document.createElement('span');
      glyph.className = 'nav-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = Array.from(label)[0].toLocaleUpperCase();
      const text = document.createElement('span');
      text.className = 'nav-label';
      text.textContent = label;
      link.replaceChildren(glyph, text);
      if (!link.hasAttribute('aria-label')) link.setAttribute('aria-label', label);
      if (!link.hasAttribute('title')) link.title = label;
    });
  }

  /* Phase 3 · Desktop route overflow. The Phase 2 reconciliation kept the contextual
     routes' <li> entries for the narrow sidebar but removed them from the cornice, which
     left eight routes with no desktop entry point at all. Mirror those very <li>s into one
     quiet menu in nav-actions: labels, hrefs and hashes keep a single source of truth, the
     sidebar keeps the full grouped inventory, and the nav contract is untouched.
     Desktop-only by CSS — below 769px the sidebar already lists these routes. */
  function mountRouteMenu(document, win) {
    const menu = document.getElementById('nav-more');
    const toggle = document.getElementById('nav-more-btn');
    const panel = document.getElementById('nav-more-panel');
    const links = document.querySelector('#navbar .nav-links');
    if (!menu || !toggle || !panel || !links || menu.__ibRouteMenu) return null;
    menu.__ibRouteMenu = true;

    function setOpen(open) {
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    function sync() {
      const anchors = links.querySelectorAll('li.nav-item-contextual > a[data-page]');
      panel.textContent = '';
      Array.prototype.forEach.call(anchors, function (anchor) {
        const label = anchor.querySelector('.nav-label');
        const item = document.createElement('a');
        item.className = 'nav-more-item';
        item.setAttribute('role', 'menuitem');
        item.setAttribute('href', anchor.getAttribute('href'));
        item.setAttribute('data-page', anchor.getAttribute('data-page'));
        item.textContent = (label && label.textContent) || anchor.getAttribute('aria-label') || '';
        item.addEventListener('click', function () { setOpen(false); });
        panel.appendChild(item);
      });
      if (!panel.children.length) setOpen(false);
    }
    sync();
    toggle.addEventListener('click', function (event) {
      event.stopPropagation();
      setOpen(panel.hidden);
    });
    panel.addEventListener('click', function (event) { event.stopPropagation(); });
    document.addEventListener('click', function () { if (!panel.hidden) setOpen(false); });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !panel.hidden) { setOpen(false); toggle.focus(); }
    });
    return { sync: sync, close: function () { setOpen(false); } };
  }

  let routeMenu = null;

  function mount(document, win) {    const sidebar = document && document.getElementById('navbar');
    const button = document && document.getElementById('ib-navigation-collapse');
    if (!sidebar || !button || sidebar.__ibNavigationMounted) return null;
    sidebar.__ibNavigationMounted = true;
    normalizeNavigationLinks(sidebar, document);
    routeMenu = mountRouteMenu(document, win);

    const links = sidebar.querySelector('.nav-links');
    let linksObserver = null;
    if (links && typeof win.MutationObserver === 'function') {
      linksObserver = new win.MutationObserver(function () {
        normalizeNavigationLinks(sidebar, document);
        if (routeMenu) routeMenu.sync();
      });
      linksObserver.observe(links, { childList: true, subtree: true });
    }

    const storage = browserStorage(win);
    let explicit = storedCollapsed(storage) !== null;
    let collapsed = initialCollapsed(storage, win.innerWidth);
    const scrollRegion = sidebar.querySelector('.nav-scroll-region');
    const originalLinkOrder = links ? Array.from(links.children) : [];

    function arrangeRoutesForViewport() {
      if (!links) return;
      if (Number(win.innerWidth) < DESKTOP_TOPBAR_BREAKPOINT) {
        originalLinkOrder.forEach(function (node) {
          if (node.parentNode === links) links.appendChild(node);
        });
        return;
      }
      const rank = new Map(DESKTOP_ROUTE_ORDER.map(function (route, index) { return [route, index]; }));
      Array.from(links.children)
        .filter(function (node) { return node.querySelector && node.querySelector('a[data-page]'); })
        .sort(function (a, b) {
          const aRoute = a.querySelector('a[data-page]').dataset.page;
          const bRoute = b.querySelector('a[data-page]').dataset.page;
          return (rank.has(aRoute) ? rank.get(aRoute) : 999) - (rank.has(bRoute) ? rank.get(bRoute) : 999);
        })
        .forEach(function (node) { links.appendChild(node); });
    }

    function revealCurrentRoute() {
      if (!scrollRegion) return;
      const current = sidebar.querySelector('.nav-links a[aria-current="page"], .nav-links a.active');
      if (!current) return;
      const viewport = scrollRegion.getBoundingClientRect();
      const item = current.getBoundingClientRect();
      if (item.top < viewport.top + 6) scrollRegion.scrollTop -= (viewport.top + 6) - item.top;
      else if (item.bottom > viewport.bottom - 6) scrollRegion.scrollTop += item.bottom - (viewport.bottom - 6);
      if (item.left < viewport.left + 6) scrollRegion.scrollLeft -= (viewport.left + 6) - item.left;
      else if (item.right > viewport.right - 6) scrollRegion.scrollLeft += item.right - (viewport.right - 6);
    }

    function emitLayoutChange() {
      try {
        if (typeof win.Event === 'function') win.dispatchEvent(new win.Event('ib:navigation-layout-change'));
      } catch (_) { }
    }

    function refreshLocalizedChrome() {
      const i18n = win.IBI18n;
      const key = collapsed ? 'nav.expand' : 'nav.collapse';
      const label = i18n && typeof i18n.t === 'function' ? i18n.t(key) : (collapsed ? 'Expand navigation' : 'Collapse navigation');
      button.setAttribute('aria-label', label);
      button.title = label;
      if (routeMenu) routeMenu.sync();
    }

    function apply(next, persist) {
      const value = next === true;
      const changed = collapsed !== value;
      collapsed = value;
      document.body.classList.toggle('ib-nav-collapsed', collapsed);
      sidebar.dataset.collapsed = collapsed ? 'true' : 'false';
      button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      refreshLocalizedChrome();
      const glyph = button.querySelector('[aria-hidden="true"]');
      if (glyph) glyph.textContent = collapsed ? '›' : '‹';
      if (persist) {
        explicit = true;
        try { if (storage) storage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0'); } catch (_) { }
      }
      if (changed) emitLayoutChange();
      return collapsed;
    }

    button.addEventListener('click', function () { apply(!collapsed, true); });
    sidebar.querySelectorAll('.nav-links a[data-page]').forEach(function (link) {
      link.addEventListener('click', function () { win.requestAnimationFrame(revealCurrentRoute); });
    });
    win.addEventListener('hashchange', function () { win.requestAnimationFrame(revealCurrentRoute); });
    win.addEventListener('resize', function () {
      arrangeRoutesForViewport();
      if (!explicit) apply(defaultCollapsed(win.innerWidth), false);
    });
    win.addEventListener('storage', function (event) {
      if (!event || event.key !== COLLAPSED_KEY) return;
      const saved = storedCollapsed(storage);
      if (saved !== null) { explicit = true; apply(saved, false); }
    });
    document.addEventListener('ib:locale-changed', refreshLocalizedChrome);
    arrangeRoutesForViewport();
    apply(collapsed, false);

    return {
      isCollapsed: function () { return collapsed; },
      disconnect: function () { if (linksObserver) linksObserver.disconnect(); },
      setCollapsed: function (value, persist) { return apply(value, persist === true); }
    };
  }

  return {
    COLLAPSED_KEY: COLLAPSED_KEY,
    COLLAPSE_BREAKPOINT: COLLAPSE_BREAKPOINT,
    DESKTOP_ROUTE_ORDER: DESKTOP_ROUTE_ORDER,
    storedCollapsed: storedCollapsed,
    defaultCollapsed: defaultCollapsed,
    initialCollapsed: initialCollapsed,
    normalizeNavigationLinks: normalizeNavigationLinks,
    mount: mount
  };
});
